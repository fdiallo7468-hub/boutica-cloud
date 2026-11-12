import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { inventoryValuations, stock } from '../../infrastructure/database/schema';

/**
 * CUMP (coût unitaire moyen pondéré) at business + variant scope.
 * All monetary calculations use integer minor units (2 decimals) and
 * half-up rounding. Call only inside the source operation's DB transaction.
 */
@Injectable()
export class InventoryValuationService {
  private toMinorUnits(value: string | number, field: string): bigint {
    const raw = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new ConflictException(`${field} must be a non-negative decimal with at most 2 decimals`);
    }
    const [whole = '0', fraction = ''] = raw.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  }

  extendedValue(unitCost: string | number, quantity: number): string {
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new ConflictException('Inventory valuation quantity must be a non-negative safe integer');
    }
    return this.fromMinorUnits(this.toMinorUnits(unitCost, 'unit cost') * BigInt(quantity));
  }

  private fromMinorUnits(value: bigint): string {
    if (value < 0n) throw new ConflictException('Inventory valuation cannot become negative');
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private roundDivide(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) throw new ConflictException('CUMP denominator must be positive');
    return (numerator + denominator / 2n) / denominator;
  }

  private async lockStockQuantity(tx: any, businessId: string, variantId: string): Promise<number> {
    const [row] = await tx.select({ quantity: stock.quantity }).from(stock)
      .where(and(eq(stock.businessId, businessId), eq(stock.variantId, variantId)))
      .for('update');
    return row?.quantity ?? 0;
  }

  private async lockValuation(tx: any, businessId: string, variantId: string) {
    const [row] = await tx.select().from(inventoryValuations)
      .where(and(
        eq(inventoryValuations.businessId, businessId),
        eq(inventoryValuations.variantId, variantId),
      ))
      .for('update');
    return row;
  }

  async initializeOpening(tx: any, businessId: string, variantId: string, expectedQuantity: number, unitCost: string | number) {
    const actualQuantity = await this.lockStockQuantity(tx, businessId, variantId);
    if (actualQuantity !== expectedQuantity) {
      throw new ConflictException(`Opening valuation quantity mismatch: current stock is ${actualQuantity}`);
    }
    const existing = await this.lockValuation(tx, businessId, variantId);
    if (existing) throw new ConflictException('An inventory valuation already exists; opening valuation is one-time only');
    const unitCostMinor = this.toMinorUnits(unitCost, 'unitCost');
    const totalValue = unitCostMinor * BigInt(actualQuantity);
    const [created] = await tx.insert(inventoryValuations).values({
      businessId, variantId, quantity: actualQuantity,
      averageUnitCost: this.fromMinorUnits(unitCostMinor),
      totalValue: this.fromMinorUnits(totalValue),
    }).returning();
    return created;
  }

  async receive(tx: any, businessId: string, variantId: string, quantity: number, unitCost: string | number) {
    const stockQuantity = await this.lockStockQuantity(tx, businessId, variantId);
    const existing = await this.lockValuation(tx, businessId, variantId);
    if (!existing && stockQuantity > 0) {
      throw new ConflictException('Existing stock has no opening CUMP valuation; initialize its opening valuation before receiving more stock');
    }
    if (existing && existing.quantity !== stockQuantity) {
      throw new ConflictException('Stock quantity and CUMP valuation are out of sync; reconcile inventory before receiving');
    }
    const incomingValue = this.toMinorUnits(unitCost, 'purchase unit cost') * BigInt(quantity);
    const oldValue = existing ? this.toMinorUnits(existing.totalValue, 'stored inventory value') : 0n;
    const nextQuantity = stockQuantity + quantity;
    const weightedValue = oldValue + incomingValue;
    const average = this.roundDivide(weightedValue, BigInt(nextQuantity));
    const nextValue = average * BigInt(nextQuantity);
    if (existing) {
      const [updated] = await tx.update(inventoryValuations).set({
        quantity: nextQuantity,
        averageUnitCost: this.fromMinorUnits(average),
        totalValue: this.fromMinorUnits(nextValue),
        updatedAt: new Date(),
      }).where(and(
        eq(inventoryValuations.businessId, businessId),
        eq(inventoryValuations.variantId, variantId),
      )).returning();
      return updated;
    }
    const [created] = await tx.insert(inventoryValuations).values({
      businessId, variantId, quantity: nextQuantity,
      averageUnitCost: this.fromMinorUnits(average),
      totalValue: this.fromMinorUnits(nextValue),
    }).returning();
    return created;
  }

  async consume(tx: any, businessId: string, variantId: string, quantity: number): Promise<string> {
    const stockQuantity = await this.lockStockQuantity(tx, businessId, variantId);
    const valuation = await this.lockValuation(tx, businessId, variantId);
    if (!valuation) {
      throw new ConflictException('No CUMP valuation exists for this stock; initialize the opening valuation before selling or adjusting it');
    }
    if (valuation.quantity !== stockQuantity) {
      throw new ConflictException('Stock quantity and CUMP valuation are out of sync; reconcile inventory before selling');
    }
    if (quantity <= 0 || quantity > valuation.quantity) {
      throw new ConflictException('Requested quantity exceeds the valued inventory balance');
    }
    const average = this.toMinorUnits(valuation.averageUnitCost, 'average unit cost');
    const cost = average * BigInt(quantity);
    const nextQuantity = valuation.quantity - quantity;
    const nextValue = average * BigInt(nextQuantity);
    await tx.update(inventoryValuations).set({
      quantity: nextQuantity,
      averageUnitCost: nextQuantity === 0 ? '0.00' : this.fromMinorUnits(this.roundDivide(nextValue, BigInt(nextQuantity))),
      totalValue: this.fromMinorUnits(nextValue),
      updatedAt: new Date(),
    }).where(and(
      eq(inventoryValuations.businessId, businessId),
      eq(inventoryValuations.variantId, variantId),
    ));
    return this.fromMinorUnits(average);
  }

  async restoreReturn(tx: any, businessId: string, variantId: string, quantity: number, historicalUnitCost: string) {
    const stockQuantity = await this.lockStockQuantity(tx, businessId, variantId);
    const valuation = await this.lockValuation(tx, businessId, variantId);
    if (!valuation || valuation.quantity !== stockQuantity) {
      throw new ConflictException('A reconciled CUMP valuation is required before restocking a returned item');
    }
    const restoredValue = this.toMinorUnits(historicalUnitCost, 'historical sale cost') * BigInt(quantity);
    const nextQuantity = valuation.quantity + quantity;
    const weightedValue = this.toMinorUnits(valuation.totalValue, 'stored inventory value') + restoredValue;
    const average = this.roundDivide(weightedValue, BigInt(nextQuantity));
    const nextValue = average * BigInt(nextQuantity);
    await tx.update(inventoryValuations).set({
      quantity: nextQuantity,
      averageUnitCost: this.fromMinorUnits(average),
      totalValue: this.fromMinorUnits(nextValue),
      updatedAt: new Date(),
    }).where(and(
      eq(inventoryValuations.businessId, businessId),
      eq(inventoryValuations.variantId, variantId),
    ));
  }

  async adjustDown(tx: any, businessId: string, variantId: string, quantity: number) {
    return this.consume(tx, businessId, variantId, quantity);
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database';
import { inventoryBalances, payments, receivables, returns, saleItems, sales, stock, stockMovements } from '../../../infrastructure/database/schema';
import { Tenant } from '../../auth/tenant.type';
import { LoyaltyLedgerService } from '../../loyalty/loyalty-ledger.service';

@Injectable()
export class CancelSaleUseCase {
  constructor(private readonly db: DatabaseService, private readonly loyaltyLedger: LoyaltyLedgerService) {}

  async execute(tenant: Tenant, saleId: string) {
    return this.db.db.transaction(async (tx) => {
      const [sale] = await tx.select().from(sales).where(and(
        eq(sales.id, saleId), eq(sales.businessId, tenant.businessId),
      )).for('update');
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status === 'CANCELLED') return { id: sale.id, status: sale.status, alreadyCancelled: true };
      if (sale.status !== 'COMPLETED') throw new ConflictException('Only a completed sale can be cancelled');

      const [completedReturn] = await tx.select({ id: returns.id }).from(returns).where(and(
        eq(returns.businessId, tenant.businessId), eq(returns.saleId, saleId), eq(returns.status, 'COMPLETED'),
      )).limit(1);
      if (completedReturn) throw new ConflictException('A sale with completed returns cannot be cancelled; process the remaining items as returns');

      const [confirmedPayment] = await tx.select({ id: payments.id }).from(payments).where(and(
        eq(payments.businessId, tenant.businessId), eq(payments.saleId, saleId), eq(payments.status, 'CONFIRMED'),
      )).limit(1);
      if (confirmedPayment) throw new ConflictException('A sale with confirmed payments cannot be cancelled until its payment is reversed');

      const saleReceivables = await tx.select().from(receivables).where(and(
        eq(receivables.businessId, tenant.businessId), eq(receivables.saleId, saleId),
      ));
      if (saleReceivables.some((row: { paidAmount: string }) => Number(row.paidAmount) > 0)) {
        throw new ConflictException('A sale with paid receivables cannot be cancelled until its payment is reversed');
      }
      if (saleReceivables.length) {
        await tx.update(receivables).set({
          status: 'CANCELLED', remainingBalance: '0.00', updatedAt: new Date(),
        }).where(and(eq(receivables.businessId, tenant.businessId), eq(receivables.saleId, saleId)));
      }

      const items = await tx.select().from(saleItems).where(eq(saleItems.saleId, saleId));
      for (const item of items) {
        await tx.update(stock).set({
          quantity: sql`${stock.quantity} + ${item.quantity}`, updatedAt: new Date(),
        }).where(and(eq(stock.businessId, tenant.businessId), eq(stock.variantId, item.variantId)));
        await tx.insert(inventoryBalances).values({
          businessId: tenant.businessId, locationId: sale.locationId, variantId: item.variantId, quantity: item.quantity,
        }).onConflictDoUpdate({
          target: [inventoryBalances.businessId, inventoryBalances.locationId, inventoryBalances.variantId],
          set: { quantity: sql`${inventoryBalances.quantity} + ${item.quantity}`, updatedAt: new Date() },
        });
        await tx.insert(stockMovements).values({
          businessId: tenant.businessId, locationId: sale.locationId, variantId: item.variantId,
          type: 'ADJUSTMENT', quantity: item.quantity, referenceId: saleId,
          note: 'Sale cancellation — restore sellable stock',
        });
      }

      const [cancelled] = await tx.update(sales).set({ status: 'CANCELLED' }).where(and(
        eq(sales.id, saleId), eq(sales.businessId, tenant.businessId), eq(sales.status, 'COMPLETED'),
      )).returning({ id: sales.id, status: sales.status });
      if (!cancelled) throw new ConflictException('Sale status changed during cancellation');

      await this.loyaltyLedger.reverseForCancellation(tx, {
        businessId: tenant.businessId, saleId, actorUserId: tenant.userId,
      });
      return { ...cancelled, alreadyCancelled: false };
    });
  }
}

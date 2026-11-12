import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database';
import { AuditEventsService } from '../../../infrastructure/database/audit-events.service';
import { businesses, businessLocations, idempotencyKeys, inventoryBalances, purchaseItems, purchases, stock, stockMovements, suppliers, variants } from '../../../infrastructure/database/schema';
import { Money, Quantity } from '../../../common/domain';
import { hashRequestPayload } from '../../../common/idempotency/idempotency.util';
import { Tenant } from '../../auth/tenant.type';
import { Purchase, PurchaseItem } from '../domain/purchase';
import { ReceivePurchaseDto } from '../dto/receive-purchase.dto';
import { AccountingOperationalPostingService } from '../../accounting/accounting-operational-posting.service';

const ENDPOINT = 'purchases.receive';

export interface ReceivePurchaseResult {
  body: unknown;
  replayed: boolean;
}

@Injectable()
export class ReceivePurchaseUseCase {
  constructor(
    private readonly db: DatabaseService,
    private readonly accountingPosting: AccountingOperationalPostingService,
    private readonly auditEvents: AuditEventsService = new AuditEventsService(),
  ) {}

  async execute(tenant: Tenant, dto: ReceivePurchaseDto, idempotencyKey: string | undefined): Promise<ReceivePurchaseResult> {
    const requestHash = hashRequestPayload(dto);

    return this.db.db.transaction(async (tx) => {
      if (idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.businessId, tenant.businessId),
              eq(idempotencyKeys.endpoint, ENDPOINT),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used with a different request payload');
          }
          return { body: existing.responseBody, replayed: true };
        }
      }

      const [business] = await tx.select().from(businesses).where(eq(businesses.id, tenant.businessId));
      const currency = business?.currency ?? 'XOF';
      const [location] = await tx.select({ id: businessLocations.id }).from(businessLocations).where(and(
        eq(businessLocations.businessId, tenant.businessId),
        dto.locationId ? eq(businessLocations.id, dto.locationId) : eq(businessLocations.isDefault, true),
        eq(businessLocations.isActive, true),
      )).limit(1);
      if (!location) throw new BadRequestException(dto.locationId
        ? 'Selected location does not exist, is inactive, or does not belong to this business'
        : 'No active default business location is configured');

      // FIX (v2.1, client-integration audit §11): supplierId was
      // previously accepted with no ownership check at all — a caller
      // could reference another business's supplier row by UUID. Same
      // pattern as the variant ownership check below.
      if (dto.supplierId) {
        const [supplier] = await tx
          .select({ id: suppliers.id, isActive: suppliers.isActive })
          .from(suppliers)
          .where(and(eq(suppliers.id, dto.supplierId), eq(suppliers.businessId, tenant.businessId)));
        if (!supplier || !supplier.isActive) {
          throw new BadRequestException('Supplier does not exist, is archived, or does not belong to this business');
        }
      }

      const variantIds = [...new Set(dto.items.map((i) => i.variantId))];
      const ownedVariants = await tx
        .select({ id: variants.id })
        .from(variants)
        .where(and(inArray(variants.id, variantIds), eq(variants.businessId, tenant.businessId)));
      if (ownedVariants.length !== variantIds.length) {
        // FIX (P0-1): the original endpoint accepted ANY variantId with no
        // ownership check — a caller could inflate another business's
        // stock by referencing its variant UUIDs.
        throw new BadRequestException('One or more variants do not exist or do not belong to this business');
      }

      const purchaseId = randomUUID();
      const items: PurchaseItem[] = dto.items.map((item) => ({
        variantId: item.variantId,
        quantity: Quantity.of(item.quantity),
        unitPrice: Money.fromDecimal(item.unitPrice, currency),
      }));

      const purchase = Purchase.create(purchaseId, tenant.businessId, dto.supplierId ?? null, items);
      const total = purchase.total(currency);
      purchase.receive();

      const [purchaseRow] = await tx
        .insert(purchases)
        .values({ id: purchaseId, businessId: tenant.businessId, locationId: location.id, supplierId: dto.supplierId, status: 'RECEIVED', total: total.toDecimalString() })
        .returning();

      const itemRows = [];
      for (const item of purchase.items) {
        const [row] = await tx
          .insert(purchaseItems)
          .values({ purchaseId, variantId: item.variantId, quantity: item.quantity.value, unitPrice: item.unitPrice.toDecimalString() })
          .returning();
        itemRows.push(row);

        // Additive, single-statement upsert: unlike the sale/decrement
        // path, this does not need an explicit FOR UPDATE lock to be
        // correct under concurrency, because the increment always reads
        // the current committed row value at write time (Postgres
        // serializes concurrent writers to the same row automatically).
        await tx
          .insert(stock)
          .values({ variantId: item.variantId, businessId: tenant.businessId, quantity: item.quantity.value })
          .onConflictDoUpdate({
            target: stock.variantId,
            set: { quantity: sql`${stock.quantity} + ${item.quantity.value}`, updatedAt: new Date() },
          });

        await tx.insert(inventoryBalances)
          .values({ businessId: tenant.businessId, locationId: location.id, variantId: item.variantId, quantity: item.quantity.value })
          .onConflictDoUpdate({
            target: [inventoryBalances.businessId, inventoryBalances.locationId, inventoryBalances.variantId],
            set: { quantity: sql`${inventoryBalances.quantity} + ${item.quantity.value}`, updatedAt: new Date() },
          });

        await tx.insert(stockMovements).values({
          businessId: tenant.businessId,
          locationId: location.id,
          variantId: item.variantId,
          type: 'PURCHASE',
          quantity: item.quantity.value,
          referenceId: purchaseId,
        });
      }

      const accounting = await this.accountingPosting.postPurchase(tx, tenant, purchaseRow!);
      const responseBody = { ...purchaseRow, items: itemRows, accounting };

      if (idempotencyKey) {
        await tx.insert(idempotencyKeys).values({
          businessId: tenant.businessId,
          endpoint: ENDPOINT,
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody,
        });
      }

      await this.auditEvents.appendInTransaction(tx, {
        businessId: tenant.businessId,
        actorUserId: tenant.userId,
        locationId: location.id,
        action: 'purchase.received',
        resourceType: 'purchase',
        resourceId: purchaseId,
        metadata: { total: total.toDecimalString(), itemCount: itemRows.length, currency },
      });

      return { body: responseBody, replayed: false };
    });
  }
}

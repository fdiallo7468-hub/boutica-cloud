import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database';
import { AuditEventsService } from '../../../infrastructure/database/audit-events.service';
import { businesses, businessLocations, customers, idempotencyKeys, inventoryBalances, saleItems, sales, stock, stockMovements, variants } from '../../../infrastructure/database/schema';
import { Money, Quantity } from '../../../common/domain';
import { hashRequestPayload } from '../../../common/idempotency/idempotency.util';
import { Tenant } from '../../auth/tenant.type';
import { Sale, SaleItem } from '../domain/sale';
import { CreateSaleDto } from '../dto/create-sale.dto';

import { NotificationOutboxService } from '../../notifications/notification-outbox.service';
import { NOVU_EVENT_TYPES } from '../../notifications/novu.types';
import { getStockNotificationTransitions } from '../../notifications/notification-events';
import { LoyaltyLedgerService } from '../../loyalty/loyalty-ledger.service';
import { AccountingOperationalPostingService } from '../../accounting/accounting-operational-posting.service';
import { InventoryValuationService } from '../../inventory/inventory-valuation.service';

const ENDPOINT = 'sales.create';

export interface CreateSaleResult {
  body: unknown;
  replayed: boolean;
}

@Injectable()
export class CreateSaleUseCase {
  constructor(
    private readonly db: DatabaseService,
    private readonly outboxService: NotificationOutboxService,
    private readonly accountingPosting: AccountingOperationalPostingService,
    private readonly loyaltyLedger: LoyaltyLedgerService = new LoyaltyLedgerService(),
    private readonly auditEvents: AuditEventsService = new AuditEventsService(),
    private readonly inventoryValuation: InventoryValuationService = new InventoryValuationService(),
  ) {}

  async execute(tenant: Tenant, dto: CreateSaleDto, idempotencyKey: string | undefined): Promise<CreateSaleResult> {
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

      if (dto.customerId) {
        const [customer] = await tx
          .select({ id: customers.id, isActive: customers.isActive })
          .from(customers)
          .where(and(
            eq(customers.id, dto.customerId),
            eq(customers.businessId, tenant.businessId),
          ));
        if (!customer || !customer.isActive) {
          throw new BadRequestException('Customer does not exist, is archived, or does not belong to this business');
        }
      }

      const variantIds = [...new Set(dto.items.map((i) => i.variantId))].sort();

      const ownedVariants = await tx
        .select()
        .from(variants)
        .where(and(inArray(variants.id, variantIds), eq(variants.businessId, tenant.businessId)));
      if (ownedVariants.length !== variantIds.length) {
        throw new BadRequestException('One or more variants do not exist or do not belong to this business');
      }
      const variantById = new Map(ownedVariants.map((v) => [v.id, v]));

      // Lock the stock rows for every variant involved, in a fixed order,
      // so two concurrent sales touching overlapping variants serialize
      // instead of both reading a stale quantity. Fixes AUDIT_REPORT.md
      // P0-2: the original code read stock with a plain SELECT and wrote it
      // in a later statement, so two concurrent requests could both pass
      // the "enough stock" check before either had decremented anything.
      const lockedStock = await tx
        .select()
        .from(stock)
        .where(and(inArray(stock.variantId, variantIds), eq(stock.businessId, tenant.businessId)))
        .for('update');
      const stockByVariant = new Map(lockedStock.map((s) => [s.variantId, s.quantity]));

      // ROUND 2 FIX: CreateSaleDto now rejects duplicate variantIds across
      // lines (see the DTO), but this check no longer *relies* on that —
      // it sums demand per variant straight from the raw request before
      // comparing against the locked quantity, so it stays correct even if
      // that DTO guard is ever relaxed by a future change. The previous
      // version checked each line against the same un-decremented snapshot,
      // so two lines for one variant could each individually look fine
      // while together exceeding what was actually available.
      const demandByVariant = new Map<string, number>();
      for (const item of dto.items) {
        demandByVariant.set(item.variantId, (demandByVariant.get(item.variantId) ?? 0) + item.quantity);
      }
      for (const [variantId, demanded] of demandByVariant) {
        const available = stockByVariant.get(variantId) ?? 0;
        if (available < demanded) {
          throw new BadRequestException(
            `Insufficient stock for variant ${variantId}: requested ${demanded}, available ${available}`,
          );
        }
      }

      const stockTransitions = [...demandByVariant].flatMap(([variantId, demanded]) => {
        const available = stockByVariant.get(variantId) ?? 0;
        const quantity = available - demanded;
        return getStockNotificationTransitions(available, quantity)
          .map((eventType) => ({ eventType, variantId, available, quantity }));
      });

      const saleId = randomUUID();
      const items: SaleItem[] = dto.items.map((item) => {
        const variant = variantById.get(item.variantId)!;
        return {
          variantId: item.variantId,
          quantity: Quantity.of(item.quantity),
          // Price always comes from the catalog, never from the client
          // body (AUDIT_REPORT.md P0-4).
          unitPrice: Money.fromDecimal(variant.sellingPrice, currency),
        };
      });

      const discount = Money.fromDecimal(dto.discount ?? 0, currency);
      const sale = Sale.create(saleId, tenant.businessId, items, discount, dto.customerId ?? null);
      const subtotal = sale.subtotal(currency);
      const total = sale.total(currency); // throws DomainError if discount > subtotal
      sale.complete();

      const [saleRow] = await tx
        .insert(sales)
        .values({
          id: saleId,
          businessId: tenant.businessId,
          locationId: location.id,
          customerId: dto.customerId,
          subtotal: subtotal.toDecimalString(),
          discount: discount.toDecimalString(),
          total: total.toDecimalString(),
          status: 'COMPLETED',
        })
        .returning();

      const itemRows = [];
      for (const item of sale.items) {
        // NEW (v2.0): snapshot this variant's purchase price *now*, at the
        // moment of sale — fixes AUDIT_REPORT.md round 2 (R2-5): margin
        // reporting previously read variants.purchasePrice, the CURRENT
        // cost, so an old sale's reported margin would silently drift if
        // that cost changed later. See reports.controller.ts, which now
        // reads this column instead.
        const costAtSale = await this.inventoryValuation.consume(tx, tenant.businessId, item.variantId, item.quantity.value);

        const [row] = await tx
          .insert(saleItems)
          .values({
            saleId,
            variantId: item.variantId,
            quantity: item.quantity.value,
            unitPrice: item.unitPrice.toDecimalString(),
            costAtSale,
          })
          .returning();
        if (!row) throw new ConflictException('A sale item could not be persisted');
        itemRows.push(row);

        // ROUND 2 FIX: this used to compute an absolute new value from the
        // stockByVariant snapshot taken before this loop started. If two
        // lines ever touched the same variant, the second write would
        // overwrite the first's decrement instead of compounding it,
        // silently under-decrementing stock relative to what
        // stock_movements recorded. An atomic SQL decrement — the same
        // pattern already used for the increment in
        // receive-purchase.usecase.ts and create-return.usecase.ts — reads
        // the row's *current* value at write time, so it stays correct
        // regardless of how many lines touch the same variant.
        await tx
          .update(stock)
          .set({ quantity: sql`${stock.quantity} - ${item.quantity.value}`, updatedAt: new Date() })
          .where(and(eq(stock.variantId, item.variantId), eq(stock.businessId, tenant.businessId)));

        await tx.update(inventoryBalances)
          .set({ quantity: sql`${inventoryBalances.quantity} - ${item.quantity.value}`, updatedAt: new Date() })
          .where(and(
            eq(inventoryBalances.businessId, tenant.businessId),
            eq(inventoryBalances.locationId, location.id),
            eq(inventoryBalances.variantId, item.variantId),
          ));

        await tx.insert(stockMovements).values({
          businessId: tenant.businessId,
          locationId: location.id,
          variantId: item.variantId,
          type: 'SALE',
          quantity: -item.quantity.value,
          referenceId: saleId,
        });
      }

      const accounting = await this.accountingPosting.postSale(tx, tenant, saleRow!, itemRows);

      await this.loyaltyLedger.awardForSale(tx, {
        businessId: tenant.businessId,
        customerId: dto.customerId,
        saleId,
        actorUserId: tenant.userId,
        total: total.toDecimalString(),
      });

      const responseBody = { ...saleRow, items: itemRows, accounting };

      // Enqueue transactional outbox event for Novu
      await this.outboxService.enqueue(tx, {
        businessId: tenant.businessId,
        eventType: NOVU_EVENT_TYPES.SALE_COMPLETED,
        deduplicationKey: `sale-completed-${saleId}`,
        payload: {
          saleId,
          total: total.toDecimalString(),
          itemsCount: itemRows.length,
          customerId: dto.customerId || null,
          recipientId: tenant.userId,
        },
      });

      const stockEventTypes = [...new Set(stockTransitions.map(({ eventType }) => eventType))];
      for (const eventType of stockEventTypes) {
        const affectedVariants = stockTransitions
          .filter((transition) => transition.eventType === eventType)
          .map(({ variantId, available, quantity }) => ({
            variantId,
            previousQuantity: available,
            quantity,
          }));
        await this.outboxService.enqueue(tx, {
          businessId: tenant.businessId,
          eventType,
          deduplicationKey: `${tenant.businessId}:${eventType}:${saleId}`,
          payload: {
            saleId,
            variants: affectedVariants,
            ...(affectedVariants.length === 1 ? affectedVariants[0] : {}),
            recipientId: tenant.userId,
          },
        });
      }

      if (idempotencyKey) {
        // If a concurrent duplicate request reaches this insert at the same
        // time, exactly one of the two transactions wins the unique
        // constraint on (businessId, endpoint, key); the other gets a
        // unique_violation here and its ENTIRE transaction — including the
        // sale/stock writes above — rolls back. The losing client gets a
        // clean 409 and, on retry, hits the replay branch above.
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
        action: 'sale.created',
        resourceType: 'sale',
        resourceId: saleId,
        metadata: { total: total.toDecimalString(), itemCount: itemRows.length, currency },
      });

      return { body: responseBody, replayed: false };
    });
  }
}

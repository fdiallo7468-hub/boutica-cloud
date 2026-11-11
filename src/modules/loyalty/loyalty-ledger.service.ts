import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { loyaltyConfigurations, loyaltyLedger, returns, sales } from '../../infrastructure/database/schema';

/** Transactional loyalty operations. Every write shares the source sale/return transaction. */
@Injectable()
export class LoyaltyLedgerService {
  async awardForSale(tx: any, input: { businessId: string; customerId?: string | null; saleId: string; actorUserId: string; total: string }) {
    if (!input.customerId) return 0;
    const [config] = await tx.select().from(loyaltyConfigurations)
      .where(eq(loyaltyConfigurations.businessId, input.businessId));
    if (!config?.enabled || config.earnPointsPer1000 <= 0) return 0;
    const cents = Math.round(Number(input.total) * 100);
    const points = Math.floor((cents * config.earnPointsPer1000) / 100000);
    if (points <= 0) return 0;
    await tx.insert(loyaltyLedger).values({
      businessId: input.businessId,
      customerId: input.customerId,
      actorUserId: input.actorUserId,
      pointsDelta: points,
      eventType: 'SALE_EARN',
      sourceId: input.saleId,
      relatedSaleId: input.saleId,
      idempotencyKey: `sale:${input.saleId}:earn`,
      note: 'Points earned on completed sale',
    }).onConflictDoNothing();
    return points;
  }

  async reverseForReturn(tx: any, input: { businessId: string; returnId: string; saleId: string; actorUserId: string }) {
    const [sale] = await tx.select().from(sales).where(and(
      eq(sales.id, input.saleId), eq(sales.businessId, input.businessId), eq(sales.status, 'COMPLETED'),
    ));
    if (!sale?.customerId || Number(sale.total) <= 0) return 0;
    const [earned] = await tx.select({ points: sql<number>`coalesce(sum(${loyaltyLedger.pointsDelta}), 0)::int` })
      .from(loyaltyLedger).where(and(
        eq(loyaltyLedger.businessId, input.businessId),
        eq(loyaltyLedger.relatedSaleId, input.saleId),
        eq(loyaltyLedger.eventType, 'SALE_EARN'),
      ));
    const earnedPoints = Math.max(0, earned?.points ?? 0);
    if (earnedPoints === 0) return 0;

    const [returned] = await tx.select({ total: sql<string>`coalesce(sum(${returns.total}), 0)::text` })
      .from(returns).where(and(
        eq(returns.businessId, input.businessId),
        eq(returns.saleId, input.saleId),
        eq(returns.status, 'COMPLETED'),
      ));
    const [alreadyReversed] = await tx.select({ points: sql<number>`coalesce(sum(-${loyaltyLedger.pointsDelta}), 0)::int` })
      .from(loyaltyLedger).where(and(
        eq(loyaltyLedger.businessId, input.businessId),
        eq(loyaltyLedger.relatedSaleId, input.saleId),
        eq(loyaltyLedger.eventType, 'RETURN_REVERSAL'),
      ));
    const ratio = Math.min(1, Math.max(0, Number(returned?.total ?? 0) / Number(sale.total)));
    const targetReversal = Math.min(earnedPoints, Math.floor(earnedPoints * ratio));
    const delta = targetReversal - Math.max(0, alreadyReversed?.points ?? 0);
    if (delta <= 0) return 0;

    await tx.insert(loyaltyLedger).values({
      businessId: input.businessId,
      customerId: sale.customerId,
      actorUserId: input.actorUserId,
      pointsDelta: -delta,
      eventType: 'RETURN_REVERSAL',
      sourceId: input.returnId,
      relatedSaleId: input.saleId,
      idempotencyKey: `return:${input.returnId}:reverse`,
      note: 'Points reversed proportionally to completed return',
    }).onConflictDoNothing();
    return delta;
  }
}

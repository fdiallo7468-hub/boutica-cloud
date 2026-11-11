import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { TenantTransactionService } from '../../infrastructure/database/tenant-transaction.service';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NovuClientService } from './novu-client.service';
import { NovuEventType } from './novu.types';

const POLL_INTERVAL_MS = 15_000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_BATCH_SIZE = 100;

interface ClaimedOutboxReference {
  id: string;
  business_id: string;
}

interface ClaimedOutboxEvent {
  id: string;
  businessId: string;
  eventType: string;
  deduplicationKey: string;
  payload: unknown;
  attempts: number;
}

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private intervalRef: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly maxAttempts = 5;

  constructor(
    private readonly db: DatabaseService,
    private readonly novuClient: NovuClientService,
    private readonly tenantTransactions: TenantTransactionService,
  ) {}

  onModuleInit(): void {
    void this.processPendingEvents().catch((error: unknown) => {
      this.logger.error('Initial notification outbox processing failed.', error);
    });
    this.intervalRef = setInterval(() => {
      void this.processPendingEvents().catch((error: unknown) => {
        this.logger.error('Notification outbox polling failed.', error);
      });
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  /**
   * The cross-tenant claim is a narrow SECURITY DEFINER function. The worker
   * receives only row identifiers, then reads and mutates each event inside
   * a transaction carrying that event's verified business_id.
   */
  async processPendingEvents(
    batchSize = 20,
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.isProcessing = true;
    let succeeded = 0;
    let failed = 0;

    try {
      const staleLockTime = new Date(Date.now() - LOCK_TIMEOUT_MS);
      const claimResult = await this.db.baseDb.execute(sql`
        SELECT id, business_id
        FROM public.boutica_claim_notification_outbox(
          ${Math.max(1, Math.min(batchSize, MAX_BATCH_SIZE))},
          'PENDING',
          'PROCESSING',
          ${staleLockTime}
        )
      `);
      const references = claimResult.rows as ClaimedOutboxReference[];
      const claimedEvents: ClaimedOutboxEvent[] = [];

      for (const reference of references) {
        const event = await this.tenantTransactions.run(
          { businessId: reference.business_id },
          async () => {
            const [row] = await this.db.db
              .select()
              .from(notificationOutbox)
              .where(and(
                eq(notificationOutbox.id, reference.id),
                eq(notificationOutbox.businessId, reference.business_id),
                eq(notificationOutbox.status, 'PROCESSING'),
              ))
              .limit(1);

            if (!row) return undefined;
            return {
              id: row.id,
              businessId: row.businessId,
              eventType: row.eventType,
              deduplicationKey: row.deduplicationKey,
              payload: row.payload,
              attempts: row.attempts,
            };
          },
        );
        if (event) claimedEvents.push(event);
      }

      for (const event of claimedEvents) {
        try {
          const payload = (event.payload as Record<string, unknown>) || {};
          const recipientId = payload.recipientId;
          const result = await this.novuClient.triggerWorkflow(
            event.eventType as NovuEventType,
            typeof recipientId === 'string' ? recipientId : event.businessId,
            payload,
            event.deduplicationKey,
          );

          if (!result.success) {
            throw new Error(result.error || 'Échec de livraison Novu');
          }

          await this.tenantTransactions.run({ businessId: event.businessId }, async () => {
            await this.db.db
              .update(notificationOutbox)
              .set({
                status: 'DELIVERED',
                lockedAt: null,
                deliveredAt: new Date(),
                lastError: null,
              })
              .where(and(
                eq(notificationOutbox.id, event.id),
                eq(notificationOutbox.businessId, event.businessId),
                eq(notificationOutbox.status, 'PROCESSING'),
              ));
          });
          succeeded++;
        } catch (error: unknown) {
          const isFinalFailure = event.attempts >= this.maxAttempts;
          const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, event.attempts - 1)));
          const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);
          const errorMessage = error instanceof Error ? error.message : 'Unknown notification delivery error';

          await this.tenantTransactions.run({ businessId: event.businessId }, async () => {
            await this.db.db
              .update(notificationOutbox)
              .set({
                status: isFinalFailure ? 'FAILED' : 'PENDING',
                attempts: event.attempts,
                availableAt: nextAttemptAt,
                lockedAt: null,
                lastError: errorMessage.slice(0, 1_000),
              })
              .where(and(
                eq(notificationOutbox.id, event.id),
                eq(notificationOutbox.businessId, event.businessId),
                eq(notificationOutbox.status, 'PROCESSING'),
              ));
          });
          failed++;

          this.logger.warn(
            `Notification ${event.id} failed (attempt ${event.attempts}/${this.maxAttempts}); next attempt: ${nextAttemptAt.toISOString()}.`,
          );
        }
      }

      return { processed: claimedEvents.length, succeeded, failed };
    } finally {
      this.isProcessing = false;
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lte, or } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NovuClientService } from './novu-client.service';
import { NovuEventType } from './novu.types';

const POLL_INTERVAL_MS = 15_000;
const LOCK_TIMEOUT_MS = 5 * 60 * 1_000;

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private intervalRef: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly maxAttempts = 5;

  constructor(
    private readonly db: DatabaseService,
    private readonly novuClient: NovuClientService,
  ) {}

  onModuleInit(): void {
    // Run once at startup, then continue polling at a fixed interval.
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
   * Claims records atomically with FOR UPDATE SKIP LOCKED. This is safe across
   * multiple application instances; the in-memory flag only avoids overlapping
   * batches inside this process and is not treated as a distributed lock.
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
      const claimedEvents = await this.db.db.transaction(async (tx) => {
        const now = new Date();
        const staleLockTime = new Date(now.getTime() - LOCK_TIMEOUT_MS);
        const events = await tx
          .select()
          .from(notificationOutbox)
          .where(or(
            and(
              eq(notificationOutbox.status, 'PENDING'),
              lte(notificationOutbox.availableAt, now),
            ),
            and(
              eq(notificationOutbox.status, 'PROCESSING'),
              lte(notificationOutbox.lockedAt, staleLockTime),
            ),
          ))
          .orderBy(asc(notificationOutbox.createdAt))
          .limit(Math.max(1, Math.min(batchSize, 100)))
          .for('update', { skipLocked: true });

        const claimed: Array<typeof events[number] & { attempts: number }> = [];
        for (const event of events) {
          const attempts = event.attempts + 1;
          await tx
            .update(notificationOutbox)
            .set({
              status: 'PROCESSING',
              attempts,
              lockedAt: now,
            })
            .where(and(
              eq(notificationOutbox.id, event.id),
              or(
                eq(notificationOutbox.status, 'PENDING'),
                eq(notificationOutbox.status, 'PROCESSING'),
              ),
            ));
          claimed.push({ ...event, attempts });
        }
        return claimed;
      });

      for (const event of claimedEvents) {
        try {
          const recipientId = (event.payload as Record<string, unknown>)?.recipientId;
          const result = await this.novuClient.triggerWorkflow(
            event.eventType as NovuEventType,
            typeof recipientId === 'string' ? recipientId : event.businessId,
            (event.payload as Record<string, unknown>) || {},
            event.deduplicationKey,
          );

          if (!result.success) {
            throw new Error(result.error || 'Échec de livraison Novu');
          }

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
              eq(notificationOutbox.status, 'PROCESSING'),
            ));
          succeeded++;
        } catch (error: unknown) {
          const isFinalFailure = event.attempts >= this.maxAttempts;
          const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, event.attempts - 1)));
          const nextAttemptAt = new Date(Date.now() + delaySeconds * 1_000);
          const errorMessage = error instanceof Error ? error.message : 'Unknown notification delivery error';

          await this.db.db
            .update(notificationOutbox)
            .set({
              status: isFinalFailure ? 'FAILED' : 'PENDING',
              availableAt: nextAttemptAt,
              lockedAt: null,
              lastError: errorMessage.slice(0, 1_000),
            })
            .where(and(
              eq(notificationOutbox.id, event.id),
              eq(notificationOutbox.status, 'PROCESSING'),
            ));
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

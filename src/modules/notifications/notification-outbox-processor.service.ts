import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lte, lt, or } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxEvent } from './notification-events';

const POLL_INTERVAL_MS = 1_000;
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_REFRESH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const BATCH_SIZE = 10;

@Injectable()
export class NotificationOutboxProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxProcessor.name);
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private polling = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  onModuleInit(): void {
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      for (let count = 0; count < BATCH_SIZE; count += 1) {
        if (!(await this.processOne())) break;
      }
    } catch (error: unknown) {
      this.logger.error(
        'Notification outbox polling failed.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.polling = false;
      this.schedule(POLL_INTERVAL_MS);
    }
  }

  async processOne(): Promise<boolean> {
    const event = await this.claimNext();
    if (!event) return false;

    const heartbeat = setInterval(() => {
      void this.refreshLock(event.id);
    }, LOCK_REFRESH_INTERVAL_MS);
    try {
      await this.delivery.deliver(event);
      await this.database.db
        .update(notificationOutbox)
        .set({ status: 'delivered', lockedAt: null, deliveredAt: new Date(), lastError: null })
        .where(eq(notificationOutbox.id, event.id));
    } catch (error: unknown) {
      const retryAt = new Date(Date.now() + getRetryDelay(event.attempts));
      await this.database.db
        .update(notificationOutbox)
        .set({
          status: 'pending',
          availableAt: retryAt,
          lockedAt: null,
          lastError: error instanceof Error ? error.name.slice(0, 100) : 'UnknownError',
        })
        .where(eq(notificationOutbox.id, event.id));
      this.logger.error(
        `Notification ${event.id} (${event.eventType}) failed; retry scheduled for ${retryAt.toISOString()}.`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async refreshLock(eventId: string): Promise<void> {
    try {
      await this.database.db
        .update(notificationOutbox)
        .set({ lockedAt: new Date() })
        .where(and(
          eq(notificationOutbox.id, eventId),
          eq(notificationOutbox.status, 'processing'),
        ));
    } catch (error: unknown) {
      this.logger.error(
        `Could not refresh the processing lease for notification ${eventId}.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async claimNext(): Promise<NotificationOutboxEvent | undefined> {
    return this.database.db.transaction(async (tx) => {
      const now = new Date();
      const staleLockTime = new Date(now.getTime() - LOCK_TIMEOUT_MS);
      const [row] = await tx
        .select()
        .from(notificationOutbox)
        .where(or(
          and(eq(notificationOutbox.status, 'pending'), lte(notificationOutbox.availableAt, now)),
          and(eq(notificationOutbox.status, 'processing'), lt(notificationOutbox.lockedAt, staleLockTime)),
        ))
        .orderBy(asc(notificationOutbox.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return undefined;

      const [claimed] = await tx
        .update(notificationOutbox)
        .set({ status: 'processing', attempts: row.attempts + 1, lockedAt: now })
        .where(eq(notificationOutbox.id, row.id))
        .returning();
      if (!claimed) return undefined;

      return {
        id: claimed.id,
        businessId: claimed.businessId,
        eventType: claimed.eventType as NotificationOutboxEvent['eventType'],
        deduplicationKey: claimed.deduplicationKey,
        payload: claimed.payload,
        attempts: claimed.attempts,
      };
    });
  }
}

function getRetryDelay(attempts: number): number {
  return Math.min(1_000 * (2 ** Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
}

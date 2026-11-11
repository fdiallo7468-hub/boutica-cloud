import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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
      void this.refreshLock(event.id, event.businessId);
    }, LOCK_REFRESH_INTERVAL_MS);
    try {
      await this.delivery.deliver(event);
      await this.tenantTransactions.run({ businessId: event.businessId }, async () => {
        await this.database.db.execute(sql`
          SELECT public.boutica_update_notification_outbox(
            ${event.id}, ${event.businessId}, 'processing', 'delivered',
            ${event.attempts}, NULL, NULL, ${new Date()}, NULL
          )
        `);
      });
    } catch (error: unknown) {
      const retryAt = new Date(Date.now() + getRetryDelay(event.attempts));
      await this.tenantTransactions.run({ businessId: event.businessId }, async () => {
        await this.database.db.execute(sql`
          SELECT public.boutica_update_notification_outbox(
            ${event.id}, ${event.businessId}, 'processing', 'pending',
            ${event.attempts}, ${retryAt}, NULL, NULL,
            ${error instanceof Error ? error.name.slice(0, 100) : 'UnknownError'}
          )
        `);
      });
      this.logger.error(
        `Notification ${event.id} (${event.eventType}) failed; retry scheduled for ${retryAt.toISOString()}.`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async refreshLock(eventId: string, businessId: string): Promise<void> {
    try {
      await this.tenantTransactions.run({ businessId }, async () => {
        await this.database.db.execute(sql`
          SELECT public.boutica_update_notification_outbox(
            ${eventId}, ${businessId}, 'processing', 'processing',
            NULL, NULL, ${new Date()}, NULL, NULL
          )
        `);
      });
    } catch (error: unknown) {
      this.logger.error(
        `Could not refresh the processing lease for notification ${eventId}.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async claimNext(): Promise<NotificationOutboxEvent | undefined> {
    const now = new Date();
    const staleLockTime = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    const claimResult = await this.database.db.execute(sql`
      SELECT id, business_id
      FROM public.boutica_claim_notification_outbox(1, 'pending', 'processing', ${staleLockTime})
    `);
    const reference = claimResult.rows[0] as { id: string; business_id: string } | undefined;
    if (!reference) return undefined;

    return this.tenantTransactions.run({ businessId: reference.business_id }, async () => {
      const [row] = await this.database.db
        .select()
        .from(notificationOutbox)
        .where(and(
          eq(notificationOutbox.id, reference.id),
          eq(notificationOutbox.businessId, reference.business_id),
        ))
        .limit(1);
      if (!row) return undefined;

      return {
        id: row.id,
        businessId: row.businessId,
        eventType: row.eventType as NotificationOutboxEvent['eventType'],
        deduplicationKey: row.deduplicationKey,
        payload: row.payload as any,
        attempts: row.attempts,
      };
    });
  }
}

function getRetryDelay(attempts: number): number {
  return Math.min(1_000 * (2 ** Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
}

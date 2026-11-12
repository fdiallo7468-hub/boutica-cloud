import { Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { TenantTransactionService } from '../../infrastructure/database/tenant-transaction.service';
import { businesses, pushDevices, users } from '../../infrastructure/database/schema';
import {
  getNotificationCategory,
  NotificationOutboxEvent,
  NotificationRecipient,
} from './notification-events';
import { NovuNotificationOrchestrator } from './novu-notification-orchestrator.service';
import { PushNotificationsService } from './push-notifications.service';

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly novu: NovuNotificationOrchestrator,
    private readonly expo: PushNotificationsService,
    private readonly tenantTransactions: TenantTransactionService,
  ) {}

  async deliver(event: NotificationOutboxEvent): Promise<void> {
    await this.tenantTransactions.run({ businessId: event.businessId }, () =>
      this.deliverWithinTenant(event),
    );
  }

  private async deliverWithinTenant(event: NotificationOutboxEvent): Promise<void> {
    const category = getNotificationCategory(event.eventType);
    const preference = category === 'sales' ? pushDevices.salesAlerts : pushDevices.stockAlerts;
    const rows = await this.database.db
      .select({ userId: users.id, token: pushDevices.token })
      .from(pushDevices)
      .innerJoin(users, eq(pushDevices.userId, users.id))
      .where(and(
        eq(pushDevices.businessId, event.businessId),
        eq(users.businessId, event.businessId),
        eq(preference, true),
      ));

    const recipients = groupRecipients(rows);
    if (recipients.length === 0) {
      this.logger.debug(`No subscribed recipients for notification ${event.id}.`);
      return;
    }

    if (!this.novu.isConfigured) {
      await this.expo.sendEventToDevices(event, recipients.flatMap((recipient) => recipient.tokens));
      return;
    }

    const [business] = await this.database.db
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, event.businessId));
    if (!business) {
      throw new Error(`Business ${event.businessId} was not found for notification ${event.id}`);
    }

    const recipientBatchSize = 10;
    for (let offset = 0; offset < recipients.length; offset += recipientBatchSize) {
      await Promise.all(recipients.slice(offset, offset + recipientBatchSize).map((recipient) =>
        this.novu.trigger(event, recipient, business.name),
      ));
    }
  }
}

export function groupRecipients(rows: Array<{ userId: string; token: string }>): NotificationRecipient[] {
  const tokensByUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const tokens = tokensByUser.get(row.userId) ?? new Set<string>();
    tokens.add(row.token);
    tokensByUser.set(row.userId, tokens);
  }

  return [...tokensByUser].map(([userId, tokens]) => ({ userId, tokens: [...tokens] }));
}

import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { pushDevices, users } from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';
import { PushDeviceDto } from './dto/push-device.dto';
import {
  getNotificationContent,
  NotificationOutboxEvent,
} from './notification-events';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH_SIZE = 100;
const LOW_STOCK_THRESHOLD = 5;

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: { kind: string; url: string };
};

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);

  constructor(private readonly database: DatabaseService) {}

  async registerDevice(tenant: Tenant, input: PushDeviceDto): Promise<void> {
    await this.database.db
      .insert(pushDevices)
      .values({
        token: input.token,
        userId: tenant.userId,
        businessId: tenant.businessId,
        stockAlerts: input.stockAlerts,
        salesAlerts: input.salesAlerts,
      })
      .onConflictDoUpdate({
        target: pushDevices.token,
        set: {
          userId: tenant.userId,
          businessId: tenant.businessId,
          stockAlerts: input.stockAlerts,
          salesAlerts: input.salesAlerts,
          updatedAt: new Date(),
        },
      });
  }

  async removeDevice(tenant: Tenant, token: string): Promise<void> {
    await this.database.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, tenant.userId)));
  }

  async notifyLowStock(businessId: string): Promise<void> {
    try {
      const devices = await this.getSubscribedDevices(businessId, 'stock');
      await this.sendEventToDevices({
        id: 'legacy-low-stock',
        businessId,
        eventType: 'inventory.low_stock',
        deduplicationKey: 'legacy-low-stock',
        payload: { quantity: LOW_STOCK_THRESHOLD },
        attempts: 0,
      }, devices);
    } catch (error: unknown) {
      this.logger.error(
        'Could not prepare low-stock notifications.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async notifySaleCreated(businessId: string): Promise<void> {
    try {
      const devices = await this.getSubscribedDevices(businessId, 'sales');
      await this.sendEventToDevices({
        id: 'legacy-sale-created',
        businessId,
        eventType: 'sale.completed',
        deduplicationKey: 'legacy-sale-created',
        payload: {},
        attempts: 0,
      }, devices);
    } catch (error: unknown) {
      this.logger.error(
        'Could not prepare sale notifications.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async sendEventToDevices(event: NotificationOutboxEvent, tokens: string[]): Promise<void> {
    const content = getNotificationContent(event);
    await this.send(tokens.map((token) => ({
      to: token,
      title: content.title,
      body: content.body,
      data: content.data,
    })));
  }

  private async getSubscribedDevices(businessId: string, category: 'stock' | 'sales'): Promise<string[]> {
    const preference = category === 'sales' ? pushDevices.salesAlerts : pushDevices.stockAlerts;
    const devices = await this.database.db
      .select({ token: pushDevices.token })
      .from(pushDevices)
      .innerJoin(users, eq(pushDevices.userId, users.id))
      .where(and(
        eq(pushDevices.businessId, businessId),
        eq(users.businessId, businessId),
        eq(preference, true),
      ));
    return devices.map(({ token }) => token);
  }

  private async send(messages: ExpoPushMessage[]): Promise<void> {
    for (let offset = 0; offset < messages.length; offset += MAX_BATCH_SIZE) {
      const batch = messages.slice(offset, offset + MAX_BATCH_SIZE);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batch),
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(`Could not reach Expo Push Service for ${batch.length} device(s).`, { cause: error });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new Error(`Expo Push Service returned HTTP ${response.status}.`);
      }

      const payload: unknown = await response.json();

      if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
        throw new Error('Expo Push Service returned an unexpected response shape.');
      }
      if (payload.data.length !== batch.length) {
        throw new Error(`Expo Push Service returned ${payload.data.length} ticket(s) for ${batch.length} message(s).`);
      }

      const invalidTokens = payload.data.flatMap((ticket, index) => {
        if (!ticket || typeof ticket !== 'object' || !('details' in ticket)) return [];
        const details = ticket.details;
        if (!details || typeof details !== 'object' || !('error' in details)) return [];
        return details.error === 'DeviceNotRegistered' && batch[index] ? [batch[index].to] : [];
      });

      if (invalidTokens.length > 0) {
        await this.database.db
          .delete(pushDevices)
          .where(inArray(pushDevices.token, invalidTokens));
      }

      const failures = payload.data.filter((ticket) => {
        if (!ticket || typeof ticket !== 'object' || !('status' in ticket) || ticket.status !== 'error') return false;
        return !('details' in ticket)
          || !ticket.details
          || typeof ticket.details !== 'object'
          || !('error' in ticket.details)
          || ticket.details.error !== 'DeviceNotRegistered';
      }).length;
      if (failures > 0) {
        throw new Error(`Expo Push Service rejected ${failures} notification(s).`);
      }
    }
  }
}

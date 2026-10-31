import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { pushDevices } from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';
import { PushDeviceDto } from './dto/push-device.dto';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH_SIZE = 100;
const LOW_STOCK_THRESHOLD = 5;

type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: { kind: 'low-stock' | 'sale-created'; url: string };
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
      await this.sendLowStockAlert(businessId);
    } catch (error: unknown) {
      this.logger.error(
        'Could not prepare low-stock notifications.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async notifySaleCreated(businessId: string): Promise<void> {
    try {
      await this.sendSaleAlert(businessId);
    } catch (error: unknown) {
      this.logger.error(
        'Could not prepare sale notifications.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async sendLowStockAlert(businessId: string): Promise<void> {
    const devices = await this.database.db
      .select({ token: pushDevices.token })
      .from(pushDevices)
      .where(and(eq(pushDevices.businessId, businessId), eq(pushDevices.stockAlerts, true)));

    await this.send(devices.map(({ token }) => ({
      to: token,
      title: 'Stock faible',
      body: `Un article est passé à ${LOW_STOCK_THRESHOLD} unités ou moins. Ouvrez Boutica pour vérifier le stock.`,
      data: { kind: 'low-stock', url: '/products' },
    })));
  }

  private async sendSaleAlert(businessId: string): Promise<void> {
    const devices = await this.database.db
      .select({ token: pushDevices.token })
      .from(pushDevices)
      .where(and(eq(pushDevices.businessId, businessId), eq(pushDevices.salesAlerts, true)));

    await this.send(devices.map(({ token }) => ({
      to: token,
      title: 'Nouvelle vente',
      body: 'Une vente a été enregistrée dans Boutica.',
      data: { kind: 'sale-created', url: '/sales' },
    })));
  }

  private async send(messages: ExpoPushMessage[]): Promise<void> {
    for (let offset = 0; offset < messages.length; offset += MAX_BATCH_SIZE) {
      const batch = messages.slice(offset, offset + MAX_BATCH_SIZE);
      let response: Response;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
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
        this.logger.error(
          `Could not reach Expo Push Service for ${batch.length} device(s).`,
          error instanceof Error ? error.stack : String(error),
        );
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        this.logger.error(`Expo Push Service returned HTTP ${response.status}.`);
        continue;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        this.logger.error(
          'Expo Push Service returned an unreadable response.',
          error instanceof Error ? error.stack : String(error),
        );
        continue;
      }

      if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
        this.logger.error('Expo Push Service returned an unexpected response shape.');
        continue;
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

      const failedCount = payload.data.filter(
        (ticket) => ticket && typeof ticket === 'object' && 'status' in ticket && ticket.status === 'error',
      ).length;
      if (failedCount > 0) {
        this.logger.error(`Expo Push Service rejected ${failedCount} notification(s).`);
      }
    }
  }
}

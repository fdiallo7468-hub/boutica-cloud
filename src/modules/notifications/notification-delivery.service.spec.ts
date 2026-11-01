import { PgDialect } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../../infrastructure/database/database';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxEvent } from './notification-events';
import { NovuNotificationOrchestrator } from './novu-notification-orchestrator.service';
import { PushNotificationsService } from './push-notifications.service';

describe('NotificationDeliveryService', () => {
  const businessId = 'c0d7b4e5-9d6c-4c8a-9bd1-36dc30212470';
  const event: NotificationOutboxEvent = {
    id: 'outbox-event',
    businessId,
    eventType: 'sale.completed',
    deduplicationKey: `${businessId}:sale.completed:sale-id`,
    payload: { saleId: 'sale-id', total: '1200', currency: 'XOF' },
    attempts: 1,
  };

  it('filters recipients by saved preference and verified business membership before Novu delivery', async () => {
    const rows = [
      { userId: 'user-1', token: 'ExpoPushToken[user-1-device-1]' },
      { userId: 'user-1', token: 'ExpoPushToken[user-1-device-2]' },
      { userId: 'user-2', token: 'ExpoPushToken[user-2-device]' },
    ];
    const recipientWhere = jest.fn().mockResolvedValue(rows);
    const innerJoin = jest.fn().mockReturnValue({ where: recipientWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const businessWhere = jest.fn().mockResolvedValue([{ name: 'Boutica Shop' }]);
    const businessFrom = jest.fn().mockReturnValue({ where: businessWhere });
    const select = jest.fn()
      .mockReturnValueOnce({ from })
      .mockReturnValueOnce({ from: businessFrom });
    const database = { db: { select } } as unknown as DatabaseService;
    const novu = {
      isConfigured: true,
      trigger: jest.fn().mockResolvedValue(undefined),
    } as unknown as NovuNotificationOrchestrator;
    const expo = { sendEventToDevices: jest.fn() } as unknown as PushNotificationsService;
    const delivery = new NotificationDeliveryService(database, novu, expo);

    await delivery.deliver(event);

    expect(innerJoin).toHaveBeenCalledTimes(1);
    const condition = recipientWhere.mock.calls[0][0];
    const { sql, params } = new PgDialect().sqlToQuery(condition);
    expect(sql).toContain('"push_devices"."business_id"');
    expect(sql).toContain('"users"."business_id"');
    expect(sql).toContain('"push_devices"."sales_alerts"');
    expect(params).toEqual([businessId, businessId, true]);
    expect(novu.trigger).toHaveBeenCalledTimes(2);
    expect(novu.trigger).toHaveBeenNthCalledWith(
      1,
      event,
      { userId: 'user-1', tokens: ['ExpoPushToken[user-1-device-1]', 'ExpoPushToken[user-1-device-2]'] },
      'Boutica Shop',
    );
    expect(novu.trigger).toHaveBeenNthCalledWith(
      2,
      event,
      { userId: 'user-2', tokens: ['ExpoPushToken[user-2-device]'] },
      'Boutica Shop',
    );
    expect(expo.sendEventToDevices).not.toHaveBeenCalled();
  });

  it('keeps Expo as the only delivery path when Novu is unconfigured', async () => {
    const recipientWhere = jest.fn().mockResolvedValue([
      { userId: 'user-1', token: 'ExpoPushToken[user-1-device]' },
    ]);
    const innerJoin = jest.fn().mockReturnValue({ where: recipientWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const database = { db: { select } } as unknown as DatabaseService;
    const novu = { isConfigured: false } as unknown as NovuNotificationOrchestrator;
    const expo = { sendEventToDevices: jest.fn().mockResolvedValue(undefined) } as unknown as PushNotificationsService;
    const delivery = new NotificationDeliveryService(database, novu, expo);

    await delivery.deliver(event);

    expect(expo.sendEventToDevices).toHaveBeenCalledWith(event, ['ExpoPushToken[user-1-device]']);
  });

  it('does not send to users from another business', async () => {
    const recipientWhere = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where: recipientWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const database = { db: { select } } as unknown as DatabaseService;
    const novu = { isConfigured: true, trigger: jest.fn() } as unknown as NovuNotificationOrchestrator;
    const expo = { sendEventToDevices: jest.fn() } as unknown as PushNotificationsService;
    const delivery = new NotificationDeliveryService(database, novu, expo);

    await delivery.deliver(event);

    expect(novu.trigger).not.toHaveBeenCalled();
    expect(expo.sendEventToDevices).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('uses the stock preference for inventory workflows', async () => {
    const recipientWhere = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where: recipientWhere });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const database = { db: { select } } as unknown as DatabaseService;
    const novu = { isConfigured: true, trigger: jest.fn() } as unknown as NovuNotificationOrchestrator;
    const expo = { sendEventToDevices: jest.fn() } as unknown as PushNotificationsService;
    const delivery = new NotificationDeliveryService(database, novu, expo);

    await delivery.deliver({
      ...event,
      eventType: 'inventory.low_stock',
      payload: { variantId: 'variant-id', previousQuantity: 6, quantity: 5 },
    });

    const condition = recipientWhere.mock.calls[0][0];
    const { sql, params } = new PgDialect().sqlToQuery(condition);
    expect(sql).toContain('"push_devices"."stock_alerts"');
    expect(params).toEqual([businessId, businessId, true]);
    expect(novu.trigger).not.toHaveBeenCalled();
  });
});

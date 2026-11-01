import { DatabaseService } from '../../infrastructure/database/database';
import { PushNotificationsService } from './push-notifications.service';

describe('PushNotificationsService', () => {
  const businessId = 'c0d7b4e5-9d6c-4c8a-9bd1-36dc30212470';
  let where: jest.Mock;
  let fetchMock: jest.SpyInstance;
  let service: PushNotificationsService;

  beforeEach(() => {
    where = jest.fn().mockResolvedValue([{ token: 'ExpoPushToken[test-device]' }]);
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const select = jest.fn().mockReturnValue({ from });
    const database = { db: { select } } as unknown as DatabaseService;
    service = new PushNotificationsService(database);
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: 'ok' }] }),
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends a low-stock push to registered devices', async () => {
    await service.notifyLowStock(businessId);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify([{
          to: 'ExpoPushToken[test-device]',
          title: 'Stock faible',
          body: 'Un article est passé à 5 unités ou moins. Ouvrez Boutica pour vérifier le stock.',
          data: { kind: 'low-stock', url: '/products' },
        }]),
      }),
    );
  });

  it('sends a sale push to registered devices', async () => {
    await service.notifySaleCreated(businessId);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify([{
          to: 'ExpoPushToken[test-device]',
          title: 'Nouvelle vente',
          body: 'Une vente a été enregistrée dans Boutica.',
          data: { kind: 'sale-created', url: '/sales' },
        }]),
      }),
    );
  });

  it('does not contact Expo when no device is subscribed', async () => {
    where.mockResolvedValue([]);

    await service.notifySaleCreated(businessId);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an out-of-stock push through the existing Expo transport', async () => {
    await service.sendEventToDevices({
      id: 'event-1',
      businessId,
      eventType: 'inventory.out_of_stock',
      deduplicationKey: 'out-of-stock-event',
      payload: { variantId: 'variant-1', quantity: 0 },
      attempts: 1,
    }, ['ExpoPushToken[test-device]']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        body: JSON.stringify([{
          to: 'ExpoPushToken[test-device]',
          title: 'Rupture de stock',
          body: 'Un article est en rupture de stock. Ouvrez Boutica pour vérifier le stock.',
          data: { kind: 'out-of-stock', url: '/products' },
        }]),
      }),
    );
  });

  it('surfaces Expo failures so the outbox can retry delivery', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await expect(service.sendEventToDevices({
      id: 'event-1',
      businessId,
      eventType: 'sale.completed',
      deduplicationKey: 'sale-event',
      payload: {},
      attempts: 1,
    }, ['ExpoPushToken[test-device]'])).rejects.toThrow('Could not reach Expo Push Service');
  });
});

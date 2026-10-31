import { DatabaseService } from '../../infrastructure/database/database';
import { PushNotificationsService } from './push-notifications.service';

describe('PushNotificationsService', () => {
  const businessId = 'c0d7b4e5-9d6c-4c8a-9bd1-36dc30212470';
  let where: jest.Mock;
  let fetchMock: jest.SpyInstance;
  let service: PushNotificationsService;

  beforeEach(() => {
    where = jest.fn().mockResolvedValue([{ token: 'ExpoPushToken[test-device]' }]);
    const from = jest.fn().mockReturnValue({ where });
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
});

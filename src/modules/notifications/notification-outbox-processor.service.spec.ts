import { DatabaseService } from '../../infrastructure/database/database';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxProcessor } from './notification-outbox-processor.service';

describe('NotificationOutboxProcessor', () => {
  it('keeps failed delivery pending with a retry time instead of losing the event', async () => {
    const now = new Date();
    const eventRow = {
      id: 'outbox-id',
      businessId: 'business-id',
      eventType: 'sale.completed',
      deduplicationKey: 'business-id:sale.completed:sale-id',
      payload: { saleId: 'sale-id' },
      status: 'pending',
      attempts: 0,
      availableAt: now,
      lockedAt: null,
      lastError: null,
      createdAt: now,
      deliveredAt: null,
    };
    const claimedRow = { ...eventRow, status: 'processing', attempts: 1, lockedAt: now };
    const lockedRows = jest.fn().mockResolvedValue([eventRow]);
    const limit = jest.fn().mockReturnValue({ for: lockedRows });
    const orderBy = jest.fn().mockReturnValue({ limit });
    const whereSelect = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where: whereSelect });
    const updateReturning = jest.fn().mockResolvedValue([claimedRow]);
    const whereUpdate = jest.fn().mockReturnValue({ returning: updateReturning });
    const setUpdate = jest.fn().mockReturnValue({ where: whereUpdate });
    const txUpdate = jest.fn().mockReturnValue({ set: setUpdate });
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      select: jest.fn().mockReturnValue({ from }),
      update: txUpdate,
    }));

    const retryWhere = jest.fn().mockResolvedValue(undefined);
    const retrySet = jest.fn().mockReturnValue({ where: retryWhere });
    const database = {
      db: {
        transaction,
        update: jest.fn().mockReturnValue({ set: retrySet }),
      },
    } as unknown as DatabaseService;
    const delivery = {
      deliver: jest.fn().mockRejectedValue(new Error('Novu unavailable')),
    } as unknown as NotificationDeliveryService;
    const processor = new NotificationOutboxProcessor(database, delivery);

    await expect(processor.processOne()).resolves.toBe(true);

    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({
      id: 'outbox-id',
      attempts: 1,
    }));
    expect(retrySet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      lastError: 'Error',
      availableAt: expect.any(Date),
    }));
    expect(retryWhere).toHaveBeenCalledTimes(1);
  });

  it('returns false when the outbox has no ready events', async () => {
    const lockedRows = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ for: lockedRows });
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const from = jest.fn().mockReturnValue({ where });
    const database = {
      db: {
        transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({
          select: jest.fn().mockReturnValue({ from }),
        }),
      },
    } as unknown as DatabaseService;
    const delivery = { deliver: jest.fn() } as unknown as NotificationDeliveryService;
    const processor = new NotificationOutboxProcessor(database, delivery);

    await expect(processor.processOne()).resolves.toBe(false);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});

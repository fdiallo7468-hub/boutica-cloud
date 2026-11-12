import { DatabaseService } from '../../infrastructure/database/database';
import { TenantTransactionService } from '../../infrastructure/database/tenant-transaction.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxProcessor } from './notification-outbox-processor.service';

describe('NotificationOutboxProcessor', () => {
  function createProcessor(event?: Record<string, any>) {
    const row = event ? {
      id: event.id,
      businessId: event.businessId,
      eventType: event.eventType,
      deduplicationKey: event.deduplicationKey,
      payload: event.payload,
      attempts: event.attempts,
    } : undefined;

    const database = {
      baseDb: {
        execute: jest.fn().mockResolvedValue({
          rows: event ? [{ id: event.id, business_id: event.businessId }] : [],
        }),
      },
      db: {
        select: jest.fn().mockReturnValue({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(row ? [row] : []),
            }),
          }),
        }),
        execute: jest.fn().mockResolvedValue({ rows: [] }),
      },
    } as unknown as DatabaseService;

    const tenantTransactions = {
      run: jest.fn(async (_context: unknown, work: () => Promise<unknown>) => work()),
    } as unknown as TenantTransactionService;

    const delivery = {
      deliver: jest.fn(),
    } as unknown as NotificationDeliveryService;

    const processor = new NotificationOutboxProcessor(database, delivery, tenantTransactions);
    return { processor, database, tenantTransactions, delivery };
  }

  it('keeps failed delivery pending with a retry time instead of losing the event', async () => {
    const now = new Date();
    const event = {
      id: 'outbox-id',
      businessId: 'business-id',
      eventType: 'sale.completed',
      deduplicationKey: 'business-id:sale.completed:sale-id',
      payload: { saleId: 'sale-id' },
      attempts: 1,
    };
    const { processor, database, delivery, tenantTransactions } = createProcessor(event);
    jest.spyOn(delivery, 'deliver').mockRejectedValue(new Error('Novu unavailable'));

    await expect(processor.processOne()).resolves.toBe(true);

    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({
      id: 'outbox-id',
      attempts: 1,
    }));
    expect(database.db.execute).toHaveBeenCalledTimes(1);
    expect(tenantTransactions.run).toHaveBeenCalledTimes(2);
  });

  it('returns false when the outbox has no ready events', async () => {
    const { processor, delivery, tenantTransactions } = createProcessor();

    await expect(processor.processOne()).resolves.toBe(false);
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(tenantTransactions.run).not.toHaveBeenCalled();
  });
});

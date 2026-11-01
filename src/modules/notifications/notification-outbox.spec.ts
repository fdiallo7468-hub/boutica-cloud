import { enqueueNotificationEvent } from './notification-outbox';

describe('enqueueNotificationEvent', () => {
  it('uses the unique event key to make transactionally enqueued events idempotent', async () => {
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const transaction = { insert } as never;
    const input = {
      businessId: 'business-id',
      eventType: 'sale.completed' as const,
      deduplicationKey: 'business-id:sale.completed:sale-id',
      payload: { saleId: 'sale-id', total: '1200', currency: 'XOF' },
    };

    await enqueueNotificationEvent(transaction, input);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(input);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: expect.objectContaining({ name: 'deduplication_key' }),
    });
  });
});

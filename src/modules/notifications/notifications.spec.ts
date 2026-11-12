import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NovuClientService } from './novu-client.service';
import { NOVU_EVENT_TYPES } from './novu.types';

describe('Novu Integration & Outbox Worker Engine (Part 5)', () => {
  let mockDb: any;
  let tenantTransactions: any;
  let novuClientService: NovuClientService;
  let outboxService: NotificationOutboxService;
  let outboxWorker: NotificationOutboxWorker;

  const mockConfigService: any = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'NOVU_API_KEY') return 'mock-novu-key';
      return undefined;
    }),
  };

  beforeEach(() => {
    mockDb = {
      baseDb: { execute: jest.fn().mockResolvedValue({ rows: [] }) },
      db: {
        select: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
      },
    };
    tenantTransactions = {
      run: jest.fn(async (_context: unknown, work: () => Promise<unknown>) => work()),
    };

    novuClientService = new NovuClientService(mockConfigService);
    outboxService = new NotificationOutboxService(mockDb);
    outboxWorker = new NotificationOutboxWorker(mockDb, novuClientService, tenantTransactions);
  });

  describe('Outbox Enqueueing & Idempotency', () => {
    it('enqueues events with unique deduplication key inside caller transaction', async () => {
      mockDb.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([
              { id: 'outbox-1', deduplicationKey: 'sale-completed-sale-1', status: 'PENDING' },
            ]),
          }),
        }),
      });

      const res = await outboxService.enqueue(mockDb.db, {
        businessId: 'biz-1',
        eventType: NOVU_EVENT_TYPES.SALE_COMPLETED,
        deduplicationKey: 'sale-completed-sale-1',
        payload: { saleId: 'sale-1', total: 50000 },
      });

      expect(res.id).toBe('outbox-1');
      expect(res.deduplicationKey).toBe('sale-completed-sale-1');
      expect(mockDb.db.insert).toHaveBeenCalled();
    });

    it('gracefully deduplicates when event key already exists without crashing', async () => {
      mockDb.db.insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
      });

      const res = await outboxService.enqueue(mockDb.db, {
        businessId: 'biz-1',
        eventType: NOVU_EVENT_TYPES.SALE_COMPLETED,
        deduplicationKey: 'sale-completed-sale-1',
        payload: { saleId: 'sale-1', total: 50000 },
      });

      expect(res.id).toBe('deduplicated');
      expect(res.deduplicationKey).toBe('sale-completed-sale-1');
    });
  });

  describe('Worker Processing & Exponential Backoff', () => {
    function mockClaimedEvent(event: Record<string, any>): void {
      mockDb.baseDb.execute.mockResolvedValueOnce({
        rows: [{ id: event.id, business_id: event.businessId }],
      });
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([event]),
          }),
        }),
      });
    }

    it('rejects malformed claim rows before opening a tenant transaction', async () => {
      mockDb.baseDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'outbox-without-business' }],
      });

      await expect(outboxWorker.processPendingEvents(10)).rejects.toThrow(
        'Invalid notification outbox claim result at row 0: expected string id and business_id.',
      );
      expect(tenantTransactions.run).not.toHaveBeenCalled();
    });

    it('processes pending outbox records and marks them DELIVERED on success', async () => {
      const pendingRecord = {
        id: 'outbox-1',
        businessId: 'biz-1',
        eventType: NOVU_EVENT_TYPES.PAYMENT_RECEIVED,
        deduplicationKey: 'pay-1',
        payload: { paymentId: 'pay-1', amount: 25000, recipientId: 'user-1' },
        status: 'PROCESSING',
        attempts: 1,
        availableAt: new Date(Date.now() - 10000),
      };
      mockClaimedEvent(pendingRecord);

      mockDb.db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      });
      jest.spyOn(novuClientService, 'triggerWorkflow').mockResolvedValue({
        success: true,
        transactionId: 'tx-123',
      });

      const summary = await outboxWorker.processPendingEvents(10);

      expect(summary).toEqual({ processed: 1, succeeded: 1, failed: 0 });
      expect(mockDb.db.update).toHaveBeenCalled();
      expect(tenantTransactions.run).toHaveBeenCalledTimes(2);
    });

    it('implements exponential backoff on transient failure and retries up to 5 times', async () => {
      const pendingRecord = {
        id: 'outbox-fail',
        businessId: 'biz-1',
        eventType: NOVU_EVENT_TYPES.RECEIVABLE_OVERDUE,
        deduplicationKey: 'rec-overdue-1',
        payload: { receivableId: 'rec-1', remainingBalance: 75000 },
        status: 'PROCESSING',
        attempts: 2,
        availableAt: new Date(Date.now() - 5000),
      };
      mockClaimedEvent(pendingRecord);

      const updateSetMock = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
      mockDb.db.update.mockReturnValue({ set: updateSetMock });
      jest.spyOn(novuClientService, 'triggerWorkflow').mockResolvedValue({
        success: false,
        error: 'Network timeout to Novu cloud API',
      });

      const summary = await outboxWorker.processPendingEvents(10);

      expect(summary).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'PENDING',
        attempts: 2,
        lastError: 'Network timeout to Novu cloud API',
      }));
      expect(tenantTransactions.run).toHaveBeenCalledTimes(2);
    });

    it('transitions record to FAILED status when maximum attempts (5) are exhausted', async () => {
      const pendingRecord = {
        id: 'outbox-max',
        businessId: 'biz-1',
        eventType: NOVU_EVENT_TYPES.PAYMENT_RECEIVED,
        deduplicationKey: 'pay-max',
        payload: { paymentId: 'pay-max' },
        status: 'PROCESSING',
        attempts: 5,
        availableAt: new Date(Date.now() - 5000),
      };
      mockClaimedEvent(pendingRecord);

      const updateSetMock = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
      mockDb.db.update.mockReturnValue({ set: updateSetMock });
      jest.spyOn(novuClientService, 'triggerWorkflow').mockResolvedValue({
        success: false,
        error: 'Permanent subscriber error',
      });

      const summary = await outboxWorker.processPendingEvents(10);

      expect(summary).toEqual({ processed: 1, succeeded: 0, failed: 1 });
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
        status: 'FAILED',
        attempts: 5,
      }));
    });
  });
});

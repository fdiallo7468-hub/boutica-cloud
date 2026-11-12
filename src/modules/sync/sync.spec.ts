import { SyncService } from './sync.service';
import { DeviceTypeEnum } from './dto/sync.dto';
import { Tenant } from '../auth/tenant.type';

describe('Offline-First Synchronization Engine (Part 7)', () => {
  let mockDb: any;
  let mockFinanceService: any;
  let mockOutboxService: any;
  let mockAccountingPosting: any;
  let mockLoyaltyLedger: any;
  let syncService: SyncService;

  const mockTenant: Tenant = {
    userId: 'user-seller-1',
    businessId: 'biz-test-1',
    role: 'STAFF',
  };

  beforeEach(() => {
    mockFinanceService = {
      recordPayment: jest.fn().mockResolvedValue({ id: 'pay-sync-1', status: 'CONFIRMED' }),
    };

    mockOutboxService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'outbox-sync-1' }),
    };

    mockAccountingPosting = {
      postSale: jest.fn().mockResolvedValue({ status: 'NOT_CONFIGURED', entryId: null }),
      postExpense: jest.fn().mockResolvedValue({ status: 'NOT_CONFIGURED', entryId: null }),
    };
    mockLoyaltyLedger = { awardForSale: jest.fn().mockResolvedValue(20) };

    mockDb = {
      db: {
        select: jest.fn(),
        insert: jest.fn(),
        update: jest.fn(),
        execute: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(async (cb) => cb(mockDb.db)),
      },
    };

    syncService = new SyncService(mockDb, mockFinanceService, mockOutboxService, mockAccountingPosting, mockLoyaltyLedger);
  });

  describe('Device Registration & Sync Status', () => {
    it('registers a Desktop or Mobile device for Cloud synchronization', async () => {
      // Not yet registered
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([]) }),
      });

      mockDb.db.insert.mockReturnValueOnce({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([
            {
              id: 'device-1',
              deviceId: 'desktop-macbook-pro-1',
              deviceType: DeviceTypeEnum.DESKTOP,
              businessId: mockTenant.businessId,
            },
          ]),
        }),
      });

      const res = await syncService.registerDevice(mockTenant, {
        deviceId: 'desktop-macbook-pro-1',
        deviceType: DeviceTypeEnum.DESKTOP,
        deviceName: 'Caisse Principale Comptoir',
        appVersion: '2.2.0',
      });

      expect(res?.deviceId).toBe('desktop-macbook-pro-1');
      expect(mockDb.db.insert).toHaveBeenCalled();
    });

    it('returns online status with server timestamp', async () => {
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ deviceId: 'desktop-macbook-pro-1', deviceType: DeviceTypeEnum.DESKTOP }]) }),
      });
      const status = await syncService.getSyncStatus(mockTenant, 'desktop-macbook-pro-1');
      expect(status.status).toBe('ONLINE');
      expect(status.businessId).toBe(mockTenant.businessId);
      expect(status.serverTimestamp).toBeDefined();
    });
  });

  describe('Offline Batch Ingestion (Push) & Idempotency', () => {
    it('ingests offline operations in strict dependency order (Customer -> Sale -> Payment)', async () => {
      // Mock idempotency checks (none existing)
      mockDb.db.select
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([]) }) }) // customer idempotency check
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([]) }) }) // sale idempotency check
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([{ id: 'location-main' }]) }) }) // active default location
        .mockReturnValueOnce({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ id: 'cust-offline-1' }]),
            }),
          }),
        }) // sale customer tenant validation
        .mockReturnValueOnce({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ id: 'var-1', sellingPrice: '5000.00', purchasePrice: '2500.00' }]),
              }),
            }),
          }),
        }) // sale variant tenant validation
        .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve([]) }) }); // payment idempotency check

      // Mock inserts
      mockDb.db.insert
        // Customer insert
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 'cust-offline-1' }]),
            }),
          }),
        })
        // Customer op log insert
        .mockReturnValueOnce({ values: jest.fn().mockResolvedValue([]) })
        // Sale insert
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 'sale-offline-1' }]),
            }),
          }),
        })
        // SaleItem insert with server-owned catalog price and cost snapshots
        .mockReturnValueOnce({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{
          id: 'sale-item-offline-1', variantId: 'var-1', quantity: 2, unitPrice: '5000.00', costAtSale: '2500.00',
        }]) }) })
        // Stock upsert decrement
        .mockReturnValueOnce({
          values: jest.fn().mockReturnValue({
            onConflictDoUpdate: jest.fn().mockResolvedValue([]),
          }),
        })
        // Stock movement insert
        .mockReturnValueOnce({ values: jest.fn().mockResolvedValue([]) })
        // Sale op log insert
        .mockReturnValueOnce({ values: jest.fn().mockResolvedValue([]) })
        // Payment op log insert
        .mockReturnValueOnce({ values: jest.fn().mockResolvedValue([]) });

      // Mock device timestamp update
      mockDb.db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });

      const pushPayload = {
        deviceId: 'device-1',
        operations: [
          // Order intentionally scrambled to verify server sort by dependency
          {
            clientOperationId: 'op-sale-1',
            operationType: 'CREATE_SALE',
            clientTimestamp: new Date().toISOString(),
            payload: {
              id: 'sale-offline-1',
              customerId: 'cust-offline-1',
              subtotal: 10000,
              total: 10000,
              items: [{ variantId: 'var-1', quantity: 2, unitPrice: 5000, costAtSale: 0.01 }],
            },
          },
          {
            clientOperationId: 'op-cust-1',
            operationType: 'CREATE_CUSTOMER',
            clientTimestamp: new Date().toISOString(),
            payload: { id: 'cust-offline-1', name: 'Moussa Cissé' },
          },
          {
            clientOperationId: 'op-pay-1',
            operationType: 'RECORD_PAYMENT',
            clientTimestamp: new Date().toISOString(),
            payload: {
              customerId: 'cust-offline-1',
              saleId: 'sale-offline-1',
              amount: 10000,
              paymentMethod: 'CASH',
            },
          },
        ],
      };

      const result = await syncService.pushOfflineOperations(mockTenant, pushPayload as any);

      expect(result.results.length).toBe(3);
      expect(result.results.every((r) => r.status === 'COMMITTED')).toBe(true);
      expect(mockFinanceService.recordPayment).toHaveBeenCalled();
      expect(mockAccountingPosting.postSale).toHaveBeenCalledWith(expect.anything(), mockTenant, expect.objectContaining({ id: 'sale-offline-1' }), [
        expect.objectContaining({ unitPrice: '5000.00', costAtSale: '2500.00' }),
      ]);
      expect(mockLoyaltyLedger.awardForSale).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        businessId: mockTenant.businessId, customerId: 'cust-offline-1', saleId: 'sale-offline-1',
      }));
    });

    it('returns cached COMMITTED response without duplicate writes when operation is replayed', async () => {
      // Operation was already committed previously
      mockDb.db.select.mockReturnValueOnce({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                clientOperationId: 'op-already-committed',
                status: 'COMMITTED',
                payload: { entityId: 'sale-123' },
              },
            ]),
        }),
      });

      mockDb.db.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      });

      const result = await syncService.pushOfflineOperations(mockTenant, {
        deviceId: 'device-1',
        operations: [
          {
            clientOperationId: 'op-already-committed',
            operationType: 'CREATE_SALE',
            clientTimestamp: new Date().toISOString(),
            payload: { total: 5000 },
          },
        ],
      });

      expect(result.results[0]!.status).toBe('COMMITTED');
      expect(result.results[0]!.entityId).toBe('sale-123');
    });
  });
});

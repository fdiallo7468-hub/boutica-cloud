import { DatabaseService } from '../../../infrastructure/database/database';
import {
  businesses,
  businessLocations,
  inventoryBalances,
  notificationOutbox,
  saleItems,
  sales,
  stock,
  stockMovements,
  variants,
} from '../../../infrastructure/database/schema';
import { CreateSaleUseCase } from './create-sale.usecase';

describe('CreateSaleUseCase notification events', () => {
  it('writes sale and threshold-crossing events in the sale transaction without invoking a provider', async () => {
    const businessId = 'c0d7b4e5-9d6c-4c8a-9bd1-36dc30212470';
    const variantId = 'bb6b6d02-a34a-42e5-9bc5-b12feabf6f08';
    const tenant = { userId: 'owner-user-id', businessId, role: 'OWNER' as const };
    const businessWhere = jest.fn().mockResolvedValue([{ currency: 'XOF' }]);
    const locationWhere = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue([{ id: 'location-main' }]),
    });
    const variantWhere = jest.fn().mockResolvedValue([{
      id: variantId,
      businessId,
      sellingPrice: '1200.00',
      purchasePrice: '800.00',
    }]);
    const stockFor = jest.fn().mockResolvedValue([{ variantId, quantity: 6 }]);
    const stockWhere = jest.fn().mockReturnValue({ for: stockFor });
    const selectedTables: unknown[] = [];
    const buildSelectResult = (where: jest.Mock) => ({
      from: jest.fn((table: unknown) => {
        selectedTables.push(table);
        return { where };
      }),
    });
    const selectResults = [
      buildSelectResult(businessWhere),
      buildSelectResult(locationWhere),
      buildSelectResult(variantWhere),
      buildSelectResult(stockWhere),
    ];
    const select = jest.fn(() => selectResults.shift());
    const insertedEvents: Array<Record<string, unknown>> = [];
    const tx = {
      select,
      insert: jest.fn((table: unknown) => {
        if (table === sales) {
          return {
            values: jest.fn((values: { id: string }) => ({
              returning: jest.fn().mockResolvedValue([{
                id: values.id,
                businessId,
                total: '1200.00',
              }]),
            })),
          };
        }
        if (table === saleItems) {
          return {
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 'sale-item-id' }]),
            }),
          };
        }
        if (table === inventoryBalances) {
          return { values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) }) };
        }
        if (table === stockMovements) {
          return { values: jest.fn().mockResolvedValue(undefined) };
        }
        if (table === notificationOutbox) {
          return {
            values: jest.fn((values: Record<string, unknown>) => {
              insertedEvents.push(values);
              return { onConflictDoNothing: jest.fn().mockResolvedValue(undefined) };
            }),
          };
        }
        throw new Error('Unexpected insert table');
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    const database = {
      db: {
        transaction: jest.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
      },
    } as unknown as DatabaseService;
    const mockOutboxService = {
      enqueue: jest.fn(async (_tx, event) => {
        insertedEvents.push(event);
      }),
    } as any;
    const mockAuditEventsService = {
      append: jest.fn(),
      appendInTransaction: jest.fn().mockResolvedValue('audit-event-1'),
    };
    const mockAccountingPosting = {
      postSale: jest.fn().mockResolvedValue({ status: 'NOT_CONFIGURED', entryId: null }),
    };
    const useCase = new CreateSaleUseCase(database, mockOutboxService, undefined, mockAuditEventsService, mockAccountingPosting as any);

    const result = await useCase.execute(tenant, {
      items: [{ variantId, quantity: 1 }],
    }, undefined);

    expect(result.replayed).toBe(false);
    expect(mockAuditEventsService.appendInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'sale.created', resourceType: 'sale' }),
    );
    expect(insertedEvents).toHaveLength(2);
    expect(insertedEvents.map((event) => event.eventType)).toEqual([
      'sale.completed',
      'inventory.low_stock',
    ]);
    expect(insertedEvents[1]?.payload).toEqual(expect.objectContaining({
      variantId,
      previousQuantity: 6,
      quantity: 5,
    }));
    expect(selectedTables).toEqual([businesses, businessLocations, variants, stock]);
  });
});

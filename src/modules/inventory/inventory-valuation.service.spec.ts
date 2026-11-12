import { InventoryValuationService } from './inventory-valuation.service';

function selectRows(rows: unknown[]) {
  return {
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        for: jest.fn().mockResolvedValue(rows),
      })),
    })),
  };
}

describe('InventoryValuationService (CUMP)', () => {
  let service: InventoryValuationService;

  beforeEach(() => {
    service = new InventoryValuationService();
  });

  it('recalculates the weighted average from a purchase receipt', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const tx: any = {
      select: jest.fn()
        .mockReturnValueOnce(selectRows([{ quantity: 10 }]))
        .mockReturnValueOnce(selectRows([{
          businessId: 'business-1', variantId: 'variant-1', quantity: 10,
          averageUnitCost: '100.00', totalValue: '1000.00',
        }])),
      update: jest.fn(() => ({
        set: jest.fn((values) => {
          updates.push(values);
          return { where: jest.fn(() => ({ returning: jest.fn().mockResolvedValue([values]) })) };
        }),
      })),
    };

    await service.receive(tx, 'business-1', 'variant-1', 10, '200.00');

    expect(updates[0]).toMatchObject({
      quantity: 20,
      averageUnitCost: '150.00',
      totalValue: '3000.00',
    });
  });

  it('consumes the current CUMP and preserves the same unit average after a sale', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const tx: any = {
      select: jest.fn()
        .mockReturnValueOnce(selectRows([{ quantity: 20 }]))
        .mockReturnValueOnce(selectRows([{
          businessId: 'business-1', variantId: 'variant-1', quantity: 20,
          averageUnitCost: '150.00', totalValue: '3000.00',
        }])),
      update: jest.fn(() => ({
        set: jest.fn((values) => {
          updates.push(values);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };

    await expect(service.consume(tx, 'business-1', 'variant-1', 5)).resolves.toBe('150.00');
    expect(updates[0]).toMatchObject({
      quantity: 15,
      averageUnitCost: '150.00',
      totalValue: '2250.00',
    });
  });

  it('restores returned goods at their historical sale cost, then recalculates CUMP', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const tx: any = {
      select: jest.fn()
        .mockReturnValueOnce(selectRows([{ quantity: 15 }]))
        .mockReturnValueOnce(selectRows([{
          businessId: 'business-1', variantId: 'variant-1', quantity: 15,
          averageUnitCost: '150.00', totalValue: '2250.00',
        }])),
      update: jest.fn(() => ({
        set: jest.fn((values) => {
          updates.push(values);
          return { where: jest.fn().mockResolvedValue(undefined) };
        }),
      })),
    };

    await service.restoreReturn(tx, 'business-1', 'variant-1', 2, '100.00');
    expect(updates[0]).toMatchObject({
      quantity: 17,
      averageUnitCost: '144.12',
      totalValue: '2450.04',
    });
  });

  it('refuses to value legacy stock from the mutable catalog price implicitly', async () => {
    const tx: any = {
      select: jest.fn()
        .mockReturnValueOnce(selectRows([{ quantity: 8 }]))
        .mockReturnValueOnce(selectRows([])),
    };

    await expect(service.receive(tx, 'business-1', 'variant-1', 2, '50.00'))
      .rejects.toThrow('Existing stock has no opening CUMP valuation');
  });
});

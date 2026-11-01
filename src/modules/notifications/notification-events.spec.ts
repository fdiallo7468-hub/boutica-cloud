import { getStockNotificationTransitions } from './notification-events';

describe('getStockNotificationTransitions', () => {
  it('creates a low-stock event only when crossing from above five to a positive quantity at or below five', () => {
    expect(getStockNotificationTransitions(6, 5)).toEqual(['inventory.low_stock']);
    expect(getStockNotificationTransitions(5, 4)).toEqual([]);
    expect(getStockNotificationTransitions(3, 2)).toEqual([]);
    expect(getStockNotificationTransitions(0, 5)).toEqual([]);
  });

  it('creates an out-of-stock event when positive stock reaches zero, without a duplicate low-stock event', () => {
    expect(getStockNotificationTransitions(1, 0)).toEqual(['inventory.out_of_stock']);
    expect(getStockNotificationTransitions(7, 0)).toEqual(['inventory.out_of_stock']);
  });
});

import { ConfigService } from '@nestjs/config';
import { Novu } from '@novu/api';
import { Env } from '../../config/env.schema';
import { NotificationOutboxEvent } from './notification-events';
import { NovuNotificationOrchestrator } from './novu-notification-orchestrator.service';

describe('NovuNotificationOrchestrator', () => {
  const businessId = 'c0d7b4e5-9d6c-4c8a-9bd1-36dc30212470';
  const userId = 'user-internal-id';
  let trigger: jest.SpyInstance;

  beforeEach(() => {
    trigger = jest.spyOn(Novu.prototype, 'trigger').mockImplementation(
      async () => ({}) as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['sale.completed', 'NOVU_WORKFLOW_SALE_COMPLETED', { saleId: 'sale-1', total: '1200', currency: 'XOF' }],
    ['inventory.low_stock', 'NOVU_WORKFLOW_INVENTORY_LOW_STOCK', { variantId: 'variant-1', previousQuantity: 8, quantity: 5 }],
    ['inventory.out_of_stock', 'NOVU_WORKFLOW_INVENTORY_OUT_OF_STOCK', { variantId: 'variant-1', previousQuantity: 2, quantity: 0 }],
  ] as const)('triggers the configured workflow for %s', async (eventType, workflowKey, payload) => {
    const configValues = {
      NOVU_SECRET_KEY: 'test-secret',
      NOVU_SERVER_URL: undefined,
      NOVU_WORKFLOW_SALE_COMPLETED: 'sale-completed-workflow',
      NOVU_WORKFLOW_INVENTORY_LOW_STOCK: 'inventory-low-workflow',
      NOVU_WORKFLOW_INVENTORY_OUT_OF_STOCK: 'inventory-out-of-stock-workflow',
    };
    const config = {
      get: jest.fn((key: keyof typeof configValues) => configValues[key]),
    } as unknown as ConfigService<Env, true>;
    const orchestrator = new NovuNotificationOrchestrator(config);
    const event: NotificationOutboxEvent = {
      id: 'outbox-event-id',
      businessId,
      eventType,
      deduplicationKey: `${businessId}:${eventType}:entity`,
      payload,
      attempts: 1,
    };

    await orchestrator.trigger(event, { userId, tokens: ['ExponentPushToken[device]'] }, 'Boutica Shop');

    const workflowId = configValues[workflowKey];
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId,
        to: {
          subscriberId: userId,
          channels: [{
            providerId: 'expo',
            credentials: { deviceTokens: ['ExponentPushToken[device]'] },
          }],
        },
        payload: expect.objectContaining({
          eventId: event.id,
          eventType,
          businessId,
          ...payload,
        }),
        context: {
          tenant: { id: businessId, data: { name: 'Boutica Shop' } },
        },
      }),
      `${event.deduplicationKey}:${userId}`,
      { timeoutMs: 10_000 },
    );
    expect(workflowId).toBeTruthy();
  });

  it('can remain disabled when Novu is not configured', async () => {
    const config = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService<Env, true>;
    const orchestrator = new NovuNotificationOrchestrator(config);

    expect(orchestrator.isConfigured).toBe(false);
    await expect(orchestrator.trigger({
      id: 'event-1',
      businessId,
      eventType: 'sale.completed',
      deduplicationKey: 'sale-event',
      payload: {},
      attempts: 1,
    }, { userId, tokens: ['ExpoPushToken[device]'] }, 'Boutica Shop'))
      .rejects.toThrow('Novu is not configured');
  });
});

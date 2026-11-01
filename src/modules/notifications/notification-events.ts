import { ChatOrPushProviderEnum } from '@novu/api/models/components';

export type NotificationEventType =
  | 'sale.completed'
  | 'inventory.low_stock'
  | 'inventory.out_of_stock';

export interface NotificationEventPayload extends Record<string, unknown> {
  saleId?: string;
  total?: string;
  currency?: string;
  variantId?: string;
  previousQuantity?: number;
  quantity?: number;
  variants?: Array<{
    variantId: string;
    previousQuantity: number;
    quantity: number;
  }>;
}

export interface NotificationRecipient {
  userId: string;
  tokens: string[];
}

export interface NotificationOutboxEvent {
  id: string;
  businessId: string;
  eventType: NotificationEventType;
  deduplicationKey: string;
  payload: NotificationEventPayload;
  attempts: number;
}

export function getStockNotificationTransitions(
  previousQuantity: number,
  quantity: number,
): Array<'inventory.low_stock' | 'inventory.out_of_stock'> {
  if (previousQuantity > 0 && quantity === 0) return ['inventory.out_of_stock'];
  if (previousQuantity > 5 && quantity > 0 && quantity <= 5) return ['inventory.low_stock'];
  return [];
}

export function getNotificationCategory(eventType: NotificationEventType): 'stock' | 'sales' {
  return eventType === 'sale.completed' ? 'sales' : 'stock';
}

export function getWorkflowConfigKey(eventType: NotificationEventType):
  | 'NOVU_WORKFLOW_SALE_COMPLETED'
  | 'NOVU_WORKFLOW_INVENTORY_LOW_STOCK'
  | 'NOVU_WORKFLOW_INVENTORY_OUT_OF_STOCK' {
  switch (eventType) {
    case 'sale.completed':
      return 'NOVU_WORKFLOW_SALE_COMPLETED';
    case 'inventory.low_stock':
      return 'NOVU_WORKFLOW_INVENTORY_LOW_STOCK';
    case 'inventory.out_of_stock':
      return 'NOVU_WORKFLOW_INVENTORY_OUT_OF_STOCK';
  }
}

export function getNotificationContent(event: NotificationOutboxEvent): {
  title: string;
  body: string;
  data: { kind: string; url: string };
} {
  switch (event.eventType) {
    case 'sale.completed':
      return {
        title: 'Nouvelle vente',
        body: 'Une vente a été enregistrée dans Boutica.',
        data: { kind: 'sale-created', url: '/sales' },
      };
    case 'inventory.low_stock':
      return {
        title: 'Stock faible',
        body: typeof event.payload.quantity === 'number'
          ? `Un article est passé à ${event.payload.quantity} unités ou moins. Ouvrez Boutica pour vérifier le stock.`
          : 'Un ou plusieurs articles sont passés à 5 unités ou moins. Ouvrez Boutica pour vérifier le stock.',
        data: { kind: 'low-stock', url: '/products' },
      };
    case 'inventory.out_of_stock':
      return {
        title: 'Rupture de stock',
        body: 'Un article est en rupture de stock. Ouvrez Boutica pour vérifier le stock.',
        data: { kind: 'out-of-stock', url: '/products' },
      };
  }
}

export const EXPO_PROVIDER_ID = ChatOrPushProviderEnum.Expo;

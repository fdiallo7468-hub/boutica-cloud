/**
 * Types et événements officiels de l'intégration Novu pour Boutica Cloud.
 */

export const NOVU_EVENT_TYPES = {
  // Événements existants
  SALE_COMPLETED: 'sale.completed',
  INVENTORY_LOW_STOCK: 'inventory.low_stock',
  INVENTORY_OUT_OF_STOCK: 'inventory.out_of_stock',

  // Nouveaux événements financiers et créances
  PAYMENT_RECEIVED: 'payment.received',
  PAYMENT_CANCELLED: 'payment.cancelled',
  RECEIVABLE_CREATED: 'receivable.created',
  RECEIVABLE_OVERDUE: 'receivable.overdue',
  RECEIVABLE_SETTLED: 'receivable.settled',
} as const;

export type NovuEventType = (typeof NOVU_EVENT_TYPES)[keyof typeof NOVU_EVENT_TYPES];

export interface NovuEventPayload {
  businessId: string;
  eventType: NovuEventType;
  deduplicationKey: string;
  payload: Record<string, unknown>;
}

export interface OutboxRecord {
  id: string;
  businessId: string;
  eventType: string;
  deduplicationKey: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

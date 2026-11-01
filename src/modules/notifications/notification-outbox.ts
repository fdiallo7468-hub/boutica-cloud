import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../infrastructure/database/schema';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NotificationEventPayload, NotificationEventType } from './notification-events';

export type NotificationTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0];

export interface EnqueueNotificationInput {
  businessId: string;
  eventType: NotificationEventType;
  deduplicationKey: string;
  payload: NotificationEventPayload;
}

export async function enqueueNotificationEvent(
  transaction: NotificationTransaction,
  input: EnqueueNotificationInput,
): Promise<void> {
  await transaction
    .insert(notificationOutbox)
    .values(input)
    .onConflictDoNothing({ target: notificationOutbox.deduplicationKey });
}

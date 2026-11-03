import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Novu } from '@novu/api';
import type { Env } from '../../config/env.schema';
import {
  EXPO_PROVIDER_ID,
  getNotificationContent,
  getWorkflowConfigKey,
  NotificationOutboxEvent,
  NotificationRecipient,
} from './notification-events';

@Injectable()
export class NovuNotificationOrchestrator {
  private readonly client?: Novu;
  private readonly secretKey?: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.secretKey = this.config.get<string>('NOVU_SECRET_KEY', { infer: true }) || this.config.get<string>('NOVU_API_KEY', { infer: true });
    const serverURL = (this.config.get<string>('NOVU_SERVER_URL', { infer: true }) || this.config.get<string>('NOVU_BACKEND_URL', { infer: true })) as string | undefined;

    if (this.secretKey) {
      this.client = new Novu({
        secretKey: this.secretKey,
        ...(serverURL ? { serverURL } : {}),
        timeoutMs: 10_000,
        retryConfig: {
          strategy: 'backoff',
          backoff: {
            initialInterval: 500,
            maxInterval: 2_000,
            exponent: 2,
            maxElapsedTime: 5_000,
          },
          retryConnectionErrors: true,
        },
      });
    }
  }

  get isConfigured(): boolean {
    return this.client !== undefined;
  }

  async trigger(
    event: NotificationOutboxEvent,
    recipient: NotificationRecipient,
    businessName: string,
  ): Promise<void> {
    if (!this.client || !this.secretKey) {
      throw new Error('Novu is not configured');
    }

    const workflowKey = getWorkflowConfigKey(event.eventType);
    const workflowId = (this.config.get(workflowKey as any, { infer: true }) as string) || event.eventType;

    const content = getNotificationContent(event);

    await this.client.trigger(
      {
        workflowId: String(workflowId),
        to: {
          subscriberId: recipient.userId,
          channels: [{
            providerId: EXPO_PROVIDER_ID,
            credentials: { deviceTokens: recipient.tokens },
          }],
        },
        payload: {
          eventId: event.id,
          eventType: event.eventType,
          businessId: event.businessId,
          ...event.payload,
          ...content,
        },
        context: {
          tenant: {
            id: event.businessId,
            data: { name: businessName },
          },
        },
      },
      `${event.deduplicationKey}:${recipient.userId}`,
      { timeoutMs: 10_000 },
    );
  }
}

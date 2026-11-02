import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NovuClientService } from './novu-client.service';
import { NovuEventType } from './novu.types';

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private intervalRef: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private readonly maxAttempts = 5;

  constructor(
    private readonly db: DatabaseService,
    private readonly novuClient: NovuClientService,
  ) {}

  onModuleInit() {
    // Polling régulier de l'outbox toutes les 15 secondes
    this.intervalRef = setInterval(() => {
      this.processPendingEvents().catch((err) => {
        this.logger.error(`Erreur inattendue du worker Outbox : ${err.message}`);
      });
    }, 15000);
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  /**
   * Traite un lot d'événements en attente avec verrouillage logique et backoff exponentiel.
   */
  async processPendingEvents(batchSize: number = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.isProcessing) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.isProcessing = true;
    let succeeded = 0;
    let failed = 0;

    try {
      const now = new Date();

      // Récupération des événements PENDING dont le délai d'éligibilité (availableAt) est échu
      const pendingEvents = await this.db.db
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.status, 'PENDING'),
            lte(notificationOutbox.availableAt, now),
          ),
        )
        .limit(batchSize);

      if (pendingEvents.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      this.logger.debug(`[Outbox Worker] Traitement de ${pendingEvents.length} événements en attente...`);

      for (const event of pendingEvents) {
        // Verrouillage logique de l'événement
        await this.db.db
          .update(notificationOutbox)
          .set({
            status: 'PROCESSING',
            lockedAt: new Date(),
          })
          .where(eq(notificationOutbox.id, event.id));

        const recipientId = (event.payload as any)?.recipientId || event.businessId;

        // Transmission à Novu avec déduplication
        const result = await this.novuClient.triggerWorkflow(
          event.eventType as NovuEventType,
          recipientId,
          (event.payload as Record<string, unknown>) || {},
          event.deduplicationKey,
        );

        if (result.success) {
          // Succès définitif
          await this.db.db
            .update(notificationOutbox)
            .set({
              status: 'DELIVERED',
              deliveredAt: new Date(),
              lastError: null,
            })
            .where(eq(notificationOutbox.id, event.id));
          succeeded++;
        } else {
          // Échec : calcul du backoff exponentiel et gestion des retries
          const newAttempts = event.attempts + 1;
          const isFinalFailure = newAttempts >= this.maxAttempts;

          // Backoff : 5s, 10s, 20s, 40s, 80s (max 300s)
          const delaySeconds = Math.min(300, Math.pow(2, newAttempts) * 5);
          const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);

          await this.db.db
            .update(notificationOutbox)
            .set({
              status: isFinalFailure ? 'FAILED' : 'PENDING',
              attempts: newAttempts,
              availableAt: nextAttemptAt,
              lastError: result.error || 'Échec de livraison Novu',
            })
            .where(eq(notificationOutbox.id, event.id));
          failed++;

          this.logger.warn(
            `[Outbox Worker] Échec livraison événement ${event.id} (tentative ${newAttempts}/${this.maxAttempts}). Prochaine tentative à ${nextAttemptAt.toISOString()}`,
          );
        }
      }

      return {
        processed: pendingEvents.length,
        succeeded,
        failed,
      };
    } finally {
      this.isProcessing = false;
    }
  }
}

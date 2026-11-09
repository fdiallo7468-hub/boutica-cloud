import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { notificationOutbox } from '../../infrastructure/database/schema';
import { NovuEventPayload } from './novu.types';

@Injectable()
export class NotificationOutboxService {
  private readonly logger = new Logger(NotificationOutboxService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Enregistre un événement dans l'outbox transactionnelle PostgreSQL.
   * Peut s'exécuter au sein de la transaction métier appelante (tx)
   * pour garantir l'atomicité complète (si l'opération métier échoue, aucun événement orphelin n'est créé).
   */
  async enqueue(
    txOrDb: any,
    event: NovuEventPayload,
  ): Promise<{ id: string; deduplicationKey: string }> {
    const executor = txOrDb?.insert ? txOrDb : this.db.db;

    try {
      const [record] = await executor
        .insert(notificationOutbox)
        .values({
          businessId: event.businessId,
          eventType: event.eventType,
          deduplicationKey: event.deduplicationKey,
          payload: event.payload,
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      if (!record) {
        // Enregistrement déjà existant avec cette clé de déduplication (idempotence)
        this.logger.debug(
          `Événement outbox ignoré (déjà présent pour la clé ${event.deduplicationKey})`,
        );
        return { id: 'deduplicated', deduplicationKey: event.deduplicationKey };
      }

      this.logger.log(
        `Événement outbox '${event.eventType}' enfilé avec succès (id: ${record.id}, clé: ${event.deduplicationKey})`,
      );
      return { id: record.id, deduplicationKey: record.deduplicationKey };
    } catch (err: any) {
      this.logger.error(`Erreur d'enregistrement outbox : ${err.message}`);
      // The outbox write is part of the caller's business transaction.
      // Propagate the error so the business write rolls back as well; silently
      // accepting a missing event would break the transactional-outbox guarantee.
      throw err;
    }
  }

  /**
   * Liste les événements de l'outbox d'une entreprise pour audit et traçabilité.
   */
  async listOutbox(
    businessId: string,
    options: { limit?: number; offset?: number; status?: string } = {},
  ) {
    const limit = Math.min(options.limit || 50, 100);
    const offset = options.offset || 0;

    const filters = [eq(notificationOutbox.businessId, businessId)];
    if (options.status) {
      filters.push(eq(notificationOutbox.status, options.status));
    }

    const items = await this.db.db
      .select()
      .from(notificationOutbox)
      .where(and(...filters))
      .orderBy(desc(notificationOutbox.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      items,
      limit,
      offset,
    };
  }

  /**
   * Réinitialise manuellement un événement pour re-tentative immédiate.
   */
  async retryEvent(businessId: string, eventId: string) {
    const [existing] = await this.db.db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.id, eventId),
          eq(notificationOutbox.businessId, businessId),
        ),
      );

    if (!existing) {
      throw new NotFoundException('Événement outbox introuvable');
    }

    const [updated] = await this.db.db
      .update(notificationOutbox)
      .set({
        status: 'PENDING',
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
      })
      .where(eq(notificationOutbox.id, eventId))
      .returning();

    return updated;
  }
}

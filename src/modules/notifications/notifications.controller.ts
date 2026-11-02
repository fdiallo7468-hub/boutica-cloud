import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';

@ApiTags('notifications')
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(
    private readonly outboxService: NotificationOutboxService,
    private readonly outboxWorker: NotificationOutboxWorker,
  ) {}

  /**
   * Consulte la file d'attente d'événements outbox pour l'entreprise connectée.
   */
  @Get('outbox')
  async listOutbox(
    @CurrentTenant() tenant: Tenant,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('status') status?: string,
  ) {
    return this.outboxService.listOutbox(tenant.businessId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      status,
    });
  }

  /**
   * Réessaie immédiatement l'envoi d'un événement outbox en échec.
   */
  @Post('outbox/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retryEvent(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.outboxService.retryEvent(tenant.businessId, id);
  }

  /**
   * Déclenche immédiatement une passe de traitement du worker Outbox.
   */
  @Post('outbox/process')
  @HttpCode(HttpStatus.OK)
  async triggerProcessing(@CurrentTenant() _tenant: Tenant) {
    const summary = await this.outboxWorker.processPendingEvents(50);
    return {
      message: 'Traitement du worker Outbox exécuté',
      summary,
    };
  }
}

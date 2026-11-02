import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { RegisterDeviceDto, SyncPushDto } from './dto/sync.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller('api/v1/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /**
   * Enregistre un client Desktop ou Mobile pour la synchronisation Cloud.
   */
  @Post('devices/register')
  @HttpCode(HttpStatus.OK)
  async registerDevice(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.syncService.registerDevice(tenant, dto);
  }

  /**
   * État de connexion et statut de synchronisation de l'appareil.
   */
  @Get('status')
  async getStatus(
    @CurrentTenant() tenant: Tenant,
    @Query('deviceId') deviceId?: string,
  ) {
    return this.syncService.getSyncStatus(tenant, deviceId);
  }

  /**
   * Récupère le delta de toutes les entités créées ou modifiées depuis 'since'.
   */
  @Get('pull')
  async pullDeltas(
    @CurrentTenant() tenant: Tenant,
    @Query('since') since?: string,
  ) {
    return this.syncService.pullDeltas(tenant, since);
  }

  /**
   * Transmet un lot d'opérations locales créées hors ligne pour ingestion atomique.
   */
  @Post('push')
  @HttpCode(HttpStatus.OK)
  async pushOperations(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: SyncPushDto,
  ) {
    return this.syncService.pushOfflineOperations(tenant, dto);
  }
}

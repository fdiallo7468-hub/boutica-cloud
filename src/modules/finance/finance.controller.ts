import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import {
  CancelPaymentDto,
  CreatePaymentDto,
  CreateReceivableFromSaleDto,
} from './dto/finance.dto';
import { FinanceService } from './finance.service';

@ApiTags('finance')
@Controller('api/v1')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  /**
   * Enregistre un paiement (intégral, acompte ou versement différé).
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_MANAGE)
  @Post('payments')
  @HttpCode(HttpStatus.CREATED)
  async recordPayment(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.financeService.recordPayment(tenant, dto);
  }

  /**
   * Liste les paiements de l'entreprise connectée.
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  @Get('payments')
  async listPayments(
    @CurrentTenant() tenant: Tenant,
    @Query('customerId') customerId?: string,
    @Query('saleId') saleId?: string,
    @Query('receivableId') receivableId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.financeService.listPayments(tenant, {
      customerId,
      saleId,
      receivableId,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Récupère le reçu complet d'un paiement (pour ticket 80mm ou PDF).
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  @Get('payments/:id/receipt')
  async getPaymentReceipt(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.financeService.getPaymentReceipt(tenant, id);
  }

  /**
   * Annule un paiement avec traçabilité et réajustement de la créance.
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_MANAGE)
  @Post('payments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelPayment(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPaymentDto,
  ) {
    return this.financeService.cancelPayment(tenant, id, dto);
  }

  /**
   * Crée une créance client rattachée à une vente (mode partiel ou différé).
   */
  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('receivables')
  @HttpCode(HttpStatus.CREATED)
  async createReceivable(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: CreateReceivableFromSaleDto,
  ) {
    return this.financeService.createReceivableForSale(tenant, dto);
  }

  /**
   * Liste les créances clients avec statut dynamique (y compris détection OVERDUE).
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  @Get('receivables')
  async listReceivables(
    @CurrentTenant() tenant: Tenant,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('isOverdue') isOverdue?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.financeService.listReceivables(tenant, {
      customerId,
      status,
      isOverdue: isOverdue !== undefined ? isOverdue === 'true' : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  /**
   * Détail d'une créance avec historique de tous ses versements.
   */
  @RequirePermissions(PERMISSIONS.PAYMENTS_READ)
  @Get('receivables/:id')
  async getReceivableDetail(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.financeService.getReceivableDetail(tenant, id);
  }
}

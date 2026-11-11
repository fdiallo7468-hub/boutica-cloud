import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { AccountingLedgerService } from './accounting-ledger.service';

@Controller('api/v1/accounting')
export class AccountingLedgerController {
  constructor(private readonly ledger: AccountingLedgerService) {}

  @Post('entries')
  createEntry(
    @CurrentTenant() tenant: Tenant,
    @Body() body: {
      journalId: string; periodId: string; entryDate: string; description: string;
      sourceType?: string; sourceId?: string; idempotencyKey?: string;
      lines: Array<{ accountId: string; description?: string; debit?: string | number; credit?: string | number }>;
    },
  ) {
    return this.ledger.createAndPost(tenant, body, tenant.userId);
  }

  @Get('entries')
  listEntries(
    @CurrentTenant() tenant: Tenant,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('periodId') periodId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ledger.list(tenant, { from, to, periodId, limit: limit ? Number(limit) : undefined });
  }

  @Post('entries/:entryId/reverse')
  reverse(
    @CurrentTenant() tenant: Tenant,
    @Param('entryId') entryId: string,
    @Body() body: { periodId: string; entryDate: string },
  ) {
    return this.ledger.reverse(tenant, entryId, body.periodId, body.entryDate, tenant.userId);
  }

  @Get('accounts/:accountId/ledger')
  accountLedger(
    @CurrentTenant() tenant: Tenant,
    @Param('accountId') accountId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.ledger.ledger(tenant, accountId, from, to);
  }

  @Get('trial-balance')
  trialBalance(
    @CurrentTenant() tenant: Tenant,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.ledger.trialBalance(tenant, from, to);
  }
}

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Put,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  accountingAccounts,
  accountingFiscalYears,
  accountingJournals,
  accountingProfiles,
} from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';

const JOURNAL_TYPES = ['PURCHASE', 'SALES', 'CASH', 'BANK', 'GENERAL', 'OPENING', 'CLOSING', 'PAYROLL'] as const;
type JournalType = (typeof JOURNAL_TYPES)[number];

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new BadRequestException(`${field} is required and must not exceed ${maxLength} characters`);
  }
  return value.trim();
}

function validDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a valid calendar date`);
  }
  return value;
}

@Controller('api/v1/accounting')
export class AccountingController {
  constructor(private readonly database: DatabaseService) {}

  @Get('profile')
  async getProfile(@CurrentTenant() tenant: Tenant) {
    const [profile] = await this.database.db.select().from(accountingProfiles)
      .where(eq(accountingProfiles.businessId, tenant.businessId)).limit(1);
    return profile ?? null;
  }

  @Put('profile')
  async configureProfile(
    @CurrentTenant() tenant: Tenant,
    @Body() body: { countryCode?: unknown; currency?: unknown; chartVersion?: unknown; accountingSystem?: unknown },
  ) {
    const countryCode = body.countryCode === undefined ? 'ML' : requiredText(body.countryCode, 'countryCode', 2).toUpperCase();
    const currency = body.currency === undefined ? 'XOF' : requiredText(body.currency, 'currency', 3).toUpperCase();
    const chartVersion = body.chartVersion === undefined
      ? 'SYSCOHADA_2017'
      : requiredText(body.chartVersion, 'chartVersion', 40);
    const accountingSystem = body.accountingSystem === undefined ? 'NORMAL' : body.accountingSystem;
    if (countryCode !== 'ML' || currency !== 'XOF') {
      throw new BadRequestException('The initial accounting profile is restricted to Mali (ML) and XOF');
    }
    if (accountingSystem !== 'NORMAL') {
      throw new BadRequestException('Phase 4 currently supports the SYSCOHADA normal system only');
    }
    if (chartVersion !== 'SYSCOHADA_2017') {
      throw new BadRequestException('Unsupported chart version; SYSCOHADA_2017 is the configured baseline');
    }
    const [profile] = await this.database.db.insert(accountingProfiles).values({
      businessId: tenant.businessId,
      countryCode,
      currency,
      chartVersion,
      accountingSystem: 'NORMAL',
      framework: 'SYSCOHADA_REVISED',
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: accountingProfiles.businessId,
      set: { countryCode, currency, chartVersion, accountingSystem: 'NORMAL', updatedAt: new Date() },
    }).returning();
    return profile;
  }

  @Get('accounts')
  async listAccounts(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingAccounts)
      .where(eq(accountingAccounts.businessId, tenant.businessId))
      .orderBy(asc(accountingAccounts.accountNumber));
  }

  @Post('accounts')
  async createAccount(
    @CurrentTenant() tenant: Tenant,
    @Body() body: {
      accountNumber?: unknown; label?: unknown; class?: unknown;
      parentAccountId?: unknown; normalBalance?: unknown; isPostable?: unknown;
    },
  ) {
    await this.requireProfile(tenant.businessId);
    const accountNumber = requiredText(body.accountNumber, 'accountNumber', 20);
    if (!/^[1-9][0-9]{0,19}$/.test(accountNumber)) {
      throw new BadRequestException('accountNumber must be a numeric SYSCOHADA account number');
    }
    const accountClass = Number(body.class);
    if (!Number.isInteger(accountClass) || accountClass < 1 || accountClass > 9
      || Number(accountNumber[0]) !== accountClass) {
      throw new BadRequestException('class must be between 1 and 9 and match the first digit of accountNumber');
    }
    const label = requiredText(body.label, 'label', 180);
    const normalBalance = body.normalBalance;
    if (normalBalance !== 'DEBIT' && normalBalance !== 'CREDIT') {
      throw new BadRequestException('normalBalance must be DEBIT or CREDIT');
    }
    const isPostable = body.isPostable === undefined ? true : body.isPostable;
    if (typeof isPostable !== 'boolean') throw new BadRequestException('isPostable must be boolean');

    let parentAccountId: string | null = null;
    if (body.parentAccountId !== undefined && body.parentAccountId !== null) {
      parentAccountId = requiredText(body.parentAccountId, 'parentAccountId', 36);
      const [parent] = await this.database.db.select().from(accountingAccounts).where(and(
        eq(accountingAccounts.id, parentAccountId),
        eq(accountingAccounts.businessId, tenant.businessId),
      )).limit(1);
      if (!parent) throw new BadRequestException('Parent account does not exist in this business');
      if (parent.isPostable) throw new BadRequestException('A postable account cannot have child accounts');
      if (!accountNumber.startsWith(parent.accountNumber) || accountNumber === parent.accountNumber) {
        throw new BadRequestException('Child account number must extend its parent account number');
      }
    }

    try {
      const [account] = await this.database.db.insert(accountingAccounts).values({
        businessId: tenant.businessId,
        accountNumber,
        label,
        class: accountClass,
        parentAccountId,
        normalBalance,
        isPostable,
      }).returning();
      return account;
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('An account with this number already exists');
      }
      throw error;
    }
  }

  @Get('fiscal-years')
  async listFiscalYears(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingFiscalYears)
      .where(eq(accountingFiscalYears.businessId, tenant.businessId))
      .orderBy(asc(accountingFiscalYears.startDate));
  }

  @Post('fiscal-years')
  async createFiscalYear(
    @CurrentTenant() tenant: Tenant,
    @Body() body: { code?: unknown; label?: unknown; startDate?: unknown; endDate?: unknown },
  ) {
    await this.requireProfile(tenant.businessId);
    const code = requiredText(body.code, 'code', 30);
    const label = requiredText(body.label, 'label', 120);
    const startDate = validDate(body.startDate, 'startDate');
    const endDate = validDate(body.endDate, 'endDate');
    if (endDate < startDate) throw new BadRequestException('endDate must not precede startDate');

    const existing = await this.database.db.select({
      startDate: accountingFiscalYears.startDate,
      endDate: accountingFiscalYears.endDate,
    }).from(accountingFiscalYears).where(eq(accountingFiscalYears.businessId, tenant.businessId));
    if (existing.some((year) => startDate <= year.endDate && endDate >= year.startDate)) {
      throw new ConflictException('Fiscal year overlaps an existing fiscal year');
    }
    try {
      const [year] = await this.database.db.insert(accountingFiscalYears).values({
        businessId: tenant.businessId, code, label, startDate, endDate,
      }).returning();
      return year;
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('Fiscal year code already exists');
      }
      throw error;
    }
  }

  @Get('journals')
  async listJournals(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingJournals)
      .where(eq(accountingJournals.businessId, tenant.businessId))
      .orderBy(asc(accountingJournals.code));
  }

  @Post('journals')
  async createJournal(
    @CurrentTenant() tenant: Tenant,
    @Body() body: {
      code?: unknown; label?: unknown; journalType?: unknown;
      sequencePrefix?: unknown; locationId?: unknown;
    },
  ) {
    await this.requireProfile(tenant.businessId);
    const code = requiredText(body.code, 'code', 12).toUpperCase();
    const label = requiredText(body.label, 'label', 120);
    const sequencePrefix = requiredText(body.sequencePrefix, 'sequencePrefix', 20);
    if (typeof body.journalType !== 'string' || !JOURNAL_TYPES.includes(body.journalType as JournalType)) {
      throw new BadRequestException(`journalType must be one of: ${JOURNAL_TYPES.join(', ')}`);
    }
    const locationId = body.locationId === undefined || body.locationId === null
      ? null : requiredText(body.locationId, 'locationId', 36);
    try {
      const [journal] = await this.database.db.insert(accountingJournals).values({
        businessId: tenant.businessId,
        code,
        label,
        journalType: body.journalType,
        sequencePrefix,
        locationId,
      }).returning();
      return journal;
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('Journal code already exists');
      }
      if ((error as { code?: string })?.code === '23503') {
        throw new BadRequestException('Location does not belong to this business');
      }
      throw error;
    }
  }

  private async requireProfile(businessId: string): Promise<void> {
    const [profile] = await this.database.db.select({ id: accountingProfiles.id })
      .from(accountingProfiles).where(eq(accountingProfiles.businessId, businessId)).limit(1);
    if (!profile) throw new BadRequestException('Configure the accounting profile before creating accounting records');
  }
}

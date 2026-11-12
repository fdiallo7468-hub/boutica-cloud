import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  accountingAccounts,
  accountingEventMappingLines,
  accountingEventMappings,
  accountingFiscalYears,
  accountingJournals,
  accountingPeriods,
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

  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('profile')
  async getProfile(@CurrentTenant() tenant: Tenant) {
    const [profile] = await this.database.db.select().from(accountingProfiles)
      .where(eq(accountingProfiles.businessId, tenant.businessId)).limit(1);
    return profile ?? null;
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
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

  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('accounts')
  async listAccounts(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingAccounts)
      .where(eq(accountingAccounts.businessId, tenant.businessId))
      .orderBy(asc(accountingAccounts.accountNumber));
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
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

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Patch('accounts/:accountId')
  async updateAccount(
    @CurrentTenant() tenant: Tenant,
    @Param('accountId') accountId: string,
    @Body() body: { label?: unknown; normalBalance?: unknown; isPostable?: unknown; isActive?: unknown },
  ) {
    const [account] = await this.database.db.select().from(accountingAccounts).where(and(
      eq(accountingAccounts.id, accountId), eq(accountingAccounts.businessId, tenant.businessId),
    )).limit(1);
    if (!account) throw new BadRequestException('Account not found in this business');
    const updates: { label?: string; normalBalance?: 'DEBIT' | 'CREDIT'; isPostable?: boolean; isActive?: boolean; updatedAt: Date } = { updatedAt: new Date() };
    if (body.label !== undefined) updates.label = requiredText(body.label, 'label', 180);
    if (body.normalBalance !== undefined) {
      if (body.normalBalance !== 'DEBIT' && body.normalBalance !== 'CREDIT') {
        throw new BadRequestException('normalBalance must be DEBIT or CREDIT');
      }
      updates.normalBalance = body.normalBalance;
    }
    if (body.isPostable !== undefined) {
      if (typeof body.isPostable !== 'boolean') throw new BadRequestException('isPostable must be boolean');
      if (body.isPostable) {
        const [child] = await this.database.db.select({ id: accountingAccounts.id }).from(accountingAccounts)
          .where(and(eq(accountingAccounts.businessId, tenant.businessId),
            eq(accountingAccounts.parentAccountId, account.id))).limit(1);
        if (child) throw new ConflictException('An account with child accounts cannot become postable');
      }
      updates.isPostable = body.isPostable;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new BadRequestException('isActive must be boolean');
      updates.isActive = body.isActive;
    }
    const [updated] = await this.database.db.update(accountingAccounts).set(updates)
      .where(and(eq(accountingAccounts.id, accountId), eq(accountingAccounts.businessId, tenant.businessId)))
      .returning();
    return updated;
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('fiscal-years')
  async listFiscalYears(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingFiscalYears)
      .where(eq(accountingFiscalYears.businessId, tenant.businessId))
      .orderBy(asc(accountingFiscalYears.startDate));
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
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

    try {
      return await this.database.db.transaction(async (tx) => {
        // Serialize fiscal-year creation per tenant; an application-only overlap check races under concurrency.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.businessId}), hashtext('accounting-fiscal-years'))`);
        const existing = await tx.select({
          startDate: accountingFiscalYears.startDate,
          endDate: accountingFiscalYears.endDate,
        }).from(accountingFiscalYears).where(eq(accountingFiscalYears.businessId, tenant.businessId));
        if (existing.some((year) => startDate <= year.endDate && endDate >= year.startDate)) {
          throw new ConflictException('Fiscal year overlaps an existing fiscal year');
        }
        const [year] = await tx.insert(accountingFiscalYears).values({
          businessId: tenant.businessId, code, label, startDate, endDate,
        }).returning();
        return year;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('Fiscal year code already exists');
      }
      throw error;
    }
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('periods')
  async listPeriods(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingPeriods)
      .where(eq(accountingPeriods.businessId, tenant.businessId))
      .orderBy(asc(accountingPeriods.startDate), asc(accountingPeriods.code));
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Post('periods')
  async createPeriod(
    @CurrentTenant() tenant: Tenant,
    @Body() body: { fiscalYearId?: unknown; code?: unknown; label?: unknown; startDate?: unknown; endDate?: unknown },
  ) {
    await this.requireProfile(tenant.businessId);
    const fiscalYearId = requiredText(body.fiscalYearId, 'fiscalYearId', 36);
    const code = requiredText(body.code, 'code', 30);
    const label = requiredText(body.label, 'label', 120);
    const startDate = validDate(body.startDate, 'startDate');
    const endDate = validDate(body.endDate, 'endDate');
    if (endDate < startDate) throw new BadRequestException('endDate must not precede startDate');

    try {
      return await this.database.db.transaction(async (tx) => {
        // Serialize period creation per tenant to prevent concurrent overlapping periods.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.businessId}), hashtext('accounting-periods'))`);
        const [year] = await tx.select().from(accountingFiscalYears).where(and(
          eq(accountingFiscalYears.id, fiscalYearId),
          eq(accountingFiscalYears.businessId, tenant.businessId),
        )).limit(1);
        if (!year) throw new BadRequestException('Fiscal year does not exist in this business');
        if (year.status !== 'OPEN') throw new ConflictException('Periods can only be added to an open fiscal year');
        if (startDate < year.startDate || endDate > year.endDate) {
          throw new BadRequestException('Period dates must be contained within the fiscal year');
        }
        const overlap = await tx.select({ id: accountingPeriods.id }).from(accountingPeriods).where(and(
          eq(accountingPeriods.businessId, tenant.businessId),
          sql`${accountingPeriods.startDate} <= ${endDate}::date`,
          sql`${accountingPeriods.endDate} >= ${startDate}::date`,
        )).limit(1);
        if (overlap.length) throw new ConflictException('Accounting period overlaps an existing period');
        const [period] = await tx.insert(accountingPeriods).values({
          businessId: tenant.businessId, fiscalYearId, code, label, startDate, endDate,
        }).returning();
        return period;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException('Accounting period code already exists');
      }
      throw error;
    }
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Patch('periods/:periodId/status')
  async updatePeriodStatus(
    @CurrentTenant() tenant: Tenant,
    @Param('periodId') periodId: string,
    @Body() body: { status?: unknown },
  ) {
    const targetStatus = body.status;
    if (targetStatus !== 'CLOSED' && targetStatus !== 'LOCKED') {
      throw new BadRequestException('status must be CLOSED or LOCKED');
    }
    return this.database.db.transaction(async (tx) => {
      // Serialize transitions so a stale concurrent request cannot move LOCKED back to CLOSED.
      const [period] = await tx.select().from(accountingPeriods).where(and(
        eq(accountingPeriods.id, periodId), eq(accountingPeriods.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!period) throw new BadRequestException('Accounting period not found in this business');
      if (period.status === 'LOCKED') throw new ConflictException('A locked accounting period cannot change status');
      if (period.status === 'CLOSED' && body.status !== 'LOCKED') {
        throw new ConflictException('A closed accounting period can only be locked');
      }
      const [updated] = await tx.update(accountingPeriods).set({
        status: targetStatus, closedAt: period.closedAt ?? new Date(), updatedAt: new Date(),
      }).where(and(eq(accountingPeriods.id, periodId), eq(accountingPeriods.businessId, tenant.businessId)))
        .returning();
      return updated;
    });
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('journals')
  async listJournals(@CurrentTenant() tenant: Tenant) {
    return this.database.db.select().from(accountingJournals)
      .where(eq(accountingJournals.businessId, tenant.businessId))
      .orderBy(asc(accountingJournals.code));
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
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

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Patch('journals/:journalId')
  async updateJournal(
    @CurrentTenant() tenant: Tenant,
    @Param('journalId') journalId: string,
    @Body() body: { label?: unknown; sequencePrefix?: unknown; isActive?: unknown },
  ) {
    const [journal] = await this.database.db.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, journalId), eq(accountingJournals.businessId, tenant.businessId),
    )).limit(1);
    if (!journal) throw new BadRequestException('Journal not found in this business');
    const updates: { label?: string; sequencePrefix?: string; isActive?: boolean; updatedAt: Date } = { updatedAt: new Date() };
    if (body.label !== undefined) updates.label = requiredText(body.label, 'label', 120);
    if (body.sequencePrefix !== undefined) updates.sequencePrefix = requiredText(body.sequencePrefix, 'sequencePrefix', 20);
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new BadRequestException('isActive must be boolean');
      updates.isActive = body.isActive;
    }
    const [updated] = await this.database.db.update(accountingJournals).set(updates)
      .where(and(eq(accountingJournals.id, journalId), eq(accountingJournals.businessId, tenant.businessId)))
      .returning();
    return updated;
  }


  @RequirePermissions(PERMISSIONS.ACCOUNTING_READ)
  @Get('event-mappings')
  async listEventMappings(@CurrentTenant() tenant: Tenant) {
    const mappings = await this.database.db.select().from(accountingEventMappings)
      .where(eq(accountingEventMappings.businessId, tenant.businessId))
      .orderBy(asc(accountingEventMappings.sourceType), asc(accountingEventMappings.sourceCategory));
    if (!mappings.length) return [];
    const lines = await this.database.db.select().from(accountingEventMappingLines).where(and(
      eq(accountingEventMappingLines.businessId, tenant.businessId),
      inArray(accountingEventMappingLines.mappingId, mappings.map((mapping) => mapping.id)),
    )).orderBy(asc(accountingEventMappingLines.lineNumber));
    const linesByMapping = new Map<string, typeof lines>();
    for (const line of lines) {
      const group = linesByMapping.get(line.mappingId) ?? [];
      group.push(line);
      linesByMapping.set(line.mappingId, group);
    }
    return mappings.map((mapping) => ({ ...mapping, lines: linesByMapping.get(mapping.id) ?? [] }));
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Put('event-mappings/expenses/:category')
  async configureExpenseMapping(
    @CurrentTenant() tenant: Tenant,
    @Param('category') categoryParam: string,
    @Body() body: { journalId?: unknown; debitAccountId?: unknown; creditAccountId?: unknown },
  ) {
    await this.requireProfile(tenant.businessId);
    const sourceCategory = requiredText(decodeURIComponent(categoryParam), 'category', 80).toLocaleLowerCase('fr-FR');
    const journalId = requiredText(body.journalId, 'journalId', 36);
    const debitAccountId = requiredText(body.debitAccountId, 'debitAccountId', 36);
    const creditAccountId = requiredText(body.creditAccountId, 'creditAccountId', 36);
    if (debitAccountId === creditAccountId) throw new BadRequestException('Debit and credit accounts must be different');

    const [journal] = await this.database.db.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, journalId), eq(accountingJournals.businessId, tenant.businessId),
    )).limit(1);
    if (!journal || !journal.isActive || !['CASH', 'BANK', 'GENERAL'].includes(journal.journalType)) {
      throw new BadRequestException('An active CASH, BANK or GENERAL journal belonging to this business is required');
    }
    const accounts = await this.database.db.select().from(accountingAccounts).where(and(
      eq(accountingAccounts.businessId, tenant.businessId),
      inArray(accountingAccounts.id, [debitAccountId, creditAccountId]),
    ));
    if (accounts.length !== 2 || accounts.some((account) => !account.isActive || !account.isPostable)) {
      throw new BadRequestException('Both mapped accounts must be active, postable and owned by this business');
    }

    return this.database.db.transaction(async (tx) => {
      const [mapping] = await tx.insert(accountingEventMappings).values({
        businessId: tenant.businessId, sourceType: 'EXPENSE', sourceCategory, journalId,
        debitAccountId, creditAccountId, isActive: true, updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [accountingEventMappings.businessId, accountingEventMappings.sourceType, accountingEventMappings.sourceCategory],
        set: { journalId, debitAccountId, creditAccountId, isActive: true, updatedAt: new Date() },
      }).returning();
      if (!mapping) throw new ConflictException('Could not save the expense accounting template');
      await tx.delete(accountingEventMappingLines).where(and(
        eq(accountingEventMappingLines.businessId, tenant.businessId),
        eq(accountingEventMappingLines.mappingId, mapping.id),
      ));
      const lines = await tx.insert(accountingEventMappingLines).values([
        { businessId: tenant.businessId, mappingId: mapping.id, lineNumber: 1, accountId: debitAccountId, side: 'DEBIT', amountBasis: 'EXPENSE_AMOUNT', percentage: '100.0000' },
        { businessId: tenant.businessId, mappingId: mapping.id, lineNumber: 2, accountId: creditAccountId, side: 'CREDIT', amountBasis: 'EXPENSE_AMOUNT', percentage: '100.0000' },
      ]).returning();
      return { ...mapping, lines };
    });
  }

  @RequirePermissions(PERMISSIONS.ACCOUNTING_MANAGE)
  @Put('event-mappings/:sourceType/:category')
  async configureSaleMapping(
    @CurrentTenant() tenant: Tenant,
    @Param('sourceType') sourceTypeParam: string,
    @Param('category') categoryParam: string,
    @Body() body: { journalId?: unknown; lines?: unknown },
  ) {
    await this.requireProfile(tenant.businessId);
    const sourceType = requiredText(sourceTypeParam, 'sourceType', 20).toUpperCase();
    if (sourceType !== 'SALE') {
      throw new BadRequestException('This multi-line configuration endpoint currently supports SALE events only');
    }
    const sourceCategory = requiredText(decodeURIComponent(categoryParam), 'category', 80).toLowerCase();
    if (sourceCategory !== 'default') {
      throw new BadRequestException('SALE mappings currently use the fixed category "default"');
    }
    const journalId = requiredText(body.journalId, 'journalId', 36);
    if (!Array.isArray(body.lines) || body.lines.length < 2 || body.lines.length > 200) {
      throw new BadRequestException('A posting template must contain between 2 and 200 lines');
    }

    const allowedBases = new Set(['SALE_TOTAL', 'SALE_SUBTOTAL', 'SALE_DISCOUNT', 'SALE_COST_AT_SALE']);
    const normalizedLines = body.lines.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new BadRequestException(`lines[${index}] must be an object`);
      }
      const line = raw as Record<string, unknown>;
      const accountId = requiredText(line.accountId, `lines[${index}].accountId`, 36);
      if (line.side !== 'DEBIT' && line.side !== 'CREDIT') {
        throw new BadRequestException(`lines[${index}].side must be DEBIT or CREDIT`);
      }
      if (typeof line.amountBasis !== 'string' || !allowedBases.has(line.amountBasis)) {
        throw new BadRequestException(`lines[${index}].amountBasis is not supported for SALE`);
      }
      const percentage = line.percentage === undefined ? '100.0000' : String(line.percentage);
      if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(percentage) || Number(percentage) <= 0 || Number(percentage) > 100) {
        throw new BadRequestException(`lines[${index}].percentage must be greater than 0 and at most 100, with up to 4 decimals`);
      }
      const auxiliaryType = line.auxiliaryType === undefined || line.auxiliaryType === null
        ? null
        : line.auxiliaryType;
      if (auxiliaryType !== null && auxiliaryType !== 'CUSTOMER') {
        throw new BadRequestException(`lines[${index}].auxiliaryType must be CUSTOMER for SALE`);
      }
      return { accountId, side: line.side as 'DEBIT' | 'CREDIT', amountBasis: line.amountBasis, percentage, auxiliaryType };
    });
    if (!normalizedLines.some((line) => line.side === 'DEBIT') || !normalizedLines.some((line) => line.side === 'CREDIT')) {
      throw new BadRequestException('A posting template must contain at least one debit and one credit line');
    }

    const [journal] = await this.database.db.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, journalId), eq(accountingJournals.businessId, tenant.businessId),
    )).limit(1);
    if (!journal || !journal.isActive || !['SALES', 'GENERAL'].includes(journal.journalType)) {
      throw new BadRequestException('An active SALES or GENERAL journal belonging to this business is required');
    }
    const accountIds = [...new Set(normalizedLines.map((line) => line.accountId))];
    const accounts = await this.database.db.select().from(accountingAccounts).where(and(
      eq(accountingAccounts.businessId, tenant.businessId),
      inArray(accountingAccounts.id, accountIds),
    ));
    if (accounts.length !== accountIds.length || accounts.some((account) => !account.isActive || !account.isPostable)) {
      throw new BadRequestException('Every template account must be active, postable and owned by this business');
    }

    return this.database.db.transaction(async (tx) => {
      const [mapping] = await tx.insert(accountingEventMappings).values({
        businessId: tenant.businessId,
        sourceType: 'SALE',
        sourceCategory,
        journalId,
        debitAccountId: null,
        creditAccountId: null,
        isActive: true,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [accountingEventMappings.businessId, accountingEventMappings.sourceType, accountingEventMappings.sourceCategory],
        set: { journalId, debitAccountId: null, creditAccountId: null, isActive: true, updatedAt: new Date() },
      }).returning();
      if (!mapping) throw new ConflictException('Could not save the sale accounting template');
      await tx.delete(accountingEventMappingLines).where(and(
        eq(accountingEventMappingLines.businessId, tenant.businessId),
        eq(accountingEventMappingLines.mappingId, mapping.id),
      ));
      const lines = await tx.insert(accountingEventMappingLines).values(normalizedLines.map((line, index) => ({
        businessId: tenant.businessId,
        mappingId: mapping.id,
        lineNumber: index + 1,
        accountId: line.accountId,
        side: line.side,
        amountBasis: line.amountBasis,
        percentage: line.percentage,
        auxiliaryType: line.auxiliaryType,
      }))).returning();
      return { ...mapping, lines };
    });
  }

  private async requireProfile(businessId: string): Promise<void> {
    const [profile] = await this.database.db.select({ id: accountingProfiles.id })
      .from(accountingProfiles).where(eq(accountingProfiles.businessId, businessId)).limit(1);
    if (!profile) throw new BadRequestException('Configure the accounting profile before creating accounting records');
  }
}

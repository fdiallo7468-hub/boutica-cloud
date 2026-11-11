import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  accountingAccounts,
  accountingEntries,
  accountingEntryLines,
  accountingJournals,
  accountingPeriods,
} from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';

type EntryLineInput = {
  accountId: string;
  description?: string;
  debit?: string | number;
  credit?: string | number;
};

type CreateEntryInput = {
  journalId: string;
  periodId: string;
  entryDate: string;
  description: string;
  sourceType?: string;
  sourceId?: string;
  idempotencyKey?: string;
  lines: EntryLineInput[];
};

function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('entryDate must use YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('entryDate is not a valid calendar date');
  }
  return value;
}

function cents(value: string | number | undefined, field: string): bigint {
  const raw = value === undefined ? '0' : String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new BadRequestException(`${field} must be a non-negative decimal with at most 2 decimals`);
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function decimal(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

@Injectable()
export class AccountingLedgerService {
  constructor(private readonly database: DatabaseService) {}

  async createAndPost(tenant: Tenant, input: CreateEntryInput, actorId?: string) {
    if (!Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 200) {
      throw new BadRequestException('An accounting entry must contain between 2 and 200 lines');
    }
    const entryDate = dateOnly(input.entryDate);
    const description = input.description?.trim();
    if (!description || description.length > 240) throw new BadRequestException('description is required (max 240 characters)');
    if (Boolean(input.sourceType) !== Boolean(input.sourceId)) {
      throw new BadRequestException('sourceType and sourceId must be supplied together');
    }
    if (input.sourceType && input.sourceType.length > 60) throw new BadRequestException('sourceType is too long');
    if (input.sourceId && input.sourceId.length > 120) throw new BadRequestException('sourceId is too long');

    const normalized = input.lines.map((line, index) => {
      const debit = cents(line.debit, `lines[${index}].debit`);
      const credit = cents(line.credit, `lines[${index}].credit`);
      if ((debit > 0n) === (credit > 0n)) {
        throw new BadRequestException(`Line ${index + 1} must contain either a debit or a credit, not both`);
      }
      return { accountId: line.accountId, description: line.description?.trim() || null, debit, credit };
    });
    const debitTotal = normalized.reduce((sum, line) => sum + line.debit, 0n);
    const creditTotal = normalized.reduce((sum, line) => sum + line.credit, 0n);
    if (debitTotal === 0n || debitTotal !== creditTotal) {
      throw new BadRequestException('Accounting entry is not balanced: total debits must equal total credits and be positive');
    }

    const requestHash = createHash('sha256').update(JSON.stringify({ ...input, entryDate, description })).digest('hex');
    return this.database.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx.select().from(accountingEntries).where(and(
          eq(accountingEntries.businessId, tenant.businessId),
          eq(accountingEntries.idempotencyKey, input.idempotencyKey!),
        )).limit(1);
        if (existing) {
          if (existing.requestHash !== requestHash) throw new ConflictException('Idempotency key was reused with a different accounting payload');
          return this.loadEntry(tx, tenant.businessId, existing.id);
        }
      }
      if (input.sourceType && input.sourceId) {
        const [existing] = await tx.select().from(accountingEntries).where(and(
          eq(accountingEntries.businessId, tenant.businessId),
          eq(accountingEntries.sourceType, input.sourceType),
          eq(accountingEntries.sourceId, input.sourceId),
        )).limit(1);
        if (existing) return this.loadEntry(tx, tenant.businessId, existing.id);
      }

      const [journal] = await tx.select().from(accountingJournals).where(and(
        eq(accountingJournals.id, input.journalId),
        eq(accountingJournals.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!journal || !journal.isActive) throw new BadRequestException('Active journal not found in this business');

      const [period] = await tx.select().from(accountingPeriods).where(and(
        eq(accountingPeriods.id, input.periodId),
        eq(accountingPeriods.businessId, tenant.businessId),
      )).limit(1);
      if (!period) throw new NotFoundException('Accounting period not found');
      if (period.status !== 'OPEN') throw new ConflictException('Accounting period is not open');
      if (entryDate < period.startDate || entryDate > period.endDate) {
        throw new BadRequestException('entryDate must fall within the selected accounting period');
      }

      const accountIds = [...new Set(normalized.map((line) => line.accountId))];
      const accounts = await tx.select().from(accountingAccounts).where(and(
        eq(accountingAccounts.businessId, tenant.businessId),
        sql`${accountingAccounts.id} = ANY(${accountIds}::uuid[])`,
      ));
      if (accounts.length !== accountIds.length) throw new BadRequestException('One or more accounts do not belong to this business');
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      for (const line of normalized) {
        const account = accountById.get(line.accountId);
        if (!account?.isActive || !account.isPostable) {
          throw new BadRequestException(`Account ${line.accountId} is inactive or not postable`);
        }
      }

      const [sequence] = await tx.update(accountingJournals).set({
        nextSequence: sql`${accountingJournals.nextSequence} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(accountingJournals.id, journal.id),
        eq(accountingJournals.businessId, tenant.businessId),
      )).returning({ allocated: sql<number>`${accountingJournals.nextSequence} - 1` });
      const entryNumber = `${journal.sequencePrefix}${String(sequence.allocated).padStart(6, '0')}`;
      const [entry] = await tx.insert(accountingEntries).values({
        businessId: tenant.businessId,
        journalId: journal.id,
        periodId: period.id,
        entryNumber,
        entryDate,
        description,
        status: 'DRAFT',
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash,
        createdBy: actorId ?? null,
      }).returning();

      await tx.insert(accountingEntryLines).values(normalized.map((line, index) => ({
        businessId: tenant.businessId,
        entryId: entry.id,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description,
        debit: decimal(line.debit),
        credit: decimal(line.credit),
      })));
      await tx.update(accountingEntries).set({ status: 'POSTED' }).where(and(
        eq(accountingEntries.id, entry.id), eq(accountingEntries.businessId, tenant.businessId),
      ));
      return this.loadEntry(tx, tenant.businessId, entry.id);
    });
  }

  async reverse(tenant: Tenant, entryId: string, periodId: string, reversalDate: string, actorId?: string) {
    return this.database.db.transaction(async (tx) => {
      const [original] = await tx.select().from(accountingEntries).where(and(
        eq(accountingEntries.id, entryId),
        eq(accountingEntries.businessId, tenant.businessId),
      )).limit(1);
      if (!original) throw new NotFoundException('Accounting entry not found');
      const entryDate = dateOnly(reversalDate);
      const [period] = await tx.select().from(accountingPeriods).where(and(
        eq(accountingPeriods.id, periodId), eq(accountingPeriods.businessId, tenant.businessId),
      )).limit(1);
      if (!period || period.status !== 'OPEN') throw new ConflictException('Reversal requires an open accounting period');
      if (entryDate < period.startDate || entryDate > period.endDate) throw new BadRequestException('Reversal date must fall within the selected open period');
      const [journal] = await tx.select().from(accountingJournals).where(and(
        eq(accountingJournals.id, original.journalId), eq(accountingJournals.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!journal || !journal.isActive) throw new ConflictException('Original journal is not active');
      const [sequence] = await tx.update(accountingJournals).set({
        nextSequence: sql`${accountingJournals.nextSequence} + 1`, updatedAt: new Date(),
      }).where(and(eq(accountingJournals.id, journal.id), eq(accountingJournals.businessId, tenant.businessId)))
        .returning({ allocated: sql<number>`${accountingJournals.nextSequence} - 1` });
      const [existingReversal] = await tx.select().from(accountingEntries).where(and(
        eq(accountingEntries.businessId, tenant.businessId),
        eq(accountingEntries.reversalOfEntryId, original.id),
      )).limit(1);
      if (existingReversal) throw new ConflictException('This accounting entry has already been reversed');
      const lines = await tx.select().from(accountingEntryLines).where(and(
        eq(accountingEntryLines.businessId, tenant.businessId),
        eq(accountingEntryLines.entryId, original.id),
      )).orderBy(asc(accountingEntryLines.lineNumber));
      const [reversal] = await tx.insert(accountingEntries).values({
        businessId: tenant.businessId,
        journalId: original.journalId,
        periodId: period.id,
        entryNumber: `${journal.sequencePrefix}${String(sequence.allocated).padStart(6, '0')}`,
        entryDate,
        description: `Extourne: ${original.description}`.slice(0, 240),
        status: 'DRAFT',
        sourceType: 'REVERSAL',
        sourceId: original.id,
        reversalOfEntryId: original.id,
        createdBy: actorId ?? null,
      }).returning();
      await tx.insert(accountingEntryLines).values(lines.map((line, index) => ({
        businessId: tenant.businessId,
        entryId: reversal.id,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description,
        debit: line.credit,
        credit: line.debit,
      })));
      await tx.update(accountingEntries).set({ status: 'POSTED' }).where(and(
        eq(accountingEntries.id, reversal.id), eq(accountingEntries.businessId, tenant.businessId),
      ));
      return this.loadEntry(tx, tenant.businessId, reversal.id);
    });
  }

  async list(tenant: Tenant, filters: { from?: string; to?: string; periodId?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const conditions = [eq(accountingEntries.businessId, tenant.businessId)];
    if (filters.from) conditions.push(gte(accountingEntries.entryDate, dateOnly(filters.from)));
    if (filters.to) conditions.push(lte(accountingEntries.entryDate, dateOnly(filters.to)));
    if (filters.periodId) conditions.push(eq(accountingEntries.periodId, filters.periodId));
    const entries = await this.database.db.select().from(accountingEntries)
      .where(and(...conditions)).orderBy(desc(accountingEntries.entryDate), desc(accountingEntries.entryNumber)).limit(limit);
    return Promise.all(entries.map((entry) => this.loadEntry(this.database.db, tenant.businessId, entry.id)));
  }

  async ledger(tenant: Tenant, accountId: string, from?: string, to?: string) {
    const conditions = [
      eq(accountingEntryLines.businessId, tenant.businessId),
      eq(accountingEntryLines.accountId, accountId),
    ];
    if (from) conditions.push(gte(accountingEntries.entryDate, dateOnly(from)));
    if (to) conditions.push(lte(accountingEntries.entryDate, dateOnly(to)));
    const rows = await this.database.db.select({
      entryId: accountingEntries.id,
      entryNumber: accountingEntries.entryNumber,
      entryDate: accountingEntries.entryDate,
      entryDescription: accountingEntries.description,
      lineDescription: accountingEntryLines.description,
      debit: accountingEntryLines.debit,
      credit: accountingEntryLines.credit,
    }).from(accountingEntryLines)
      .innerJoin(accountingEntries, and(
        eq(accountingEntries.id, accountingEntryLines.entryId),
        eq(accountingEntries.businessId, accountingEntryLines.businessId),
      )).where(and(...conditions))
      .orderBy(asc(accountingEntries.entryDate), asc(accountingEntries.entryNumber), asc(accountingEntryLines.lineNumber));
    let debit = 0n, credit = 0n;
    return rows.map((row) => {
      debit += cents(row.debit, 'debit');
      credit += cents(row.credit, 'credit');
      return { ...row, runningDebit: decimal(debit), runningCredit: decimal(credit), balance: decimal(debit - credit) };
    });
  }

  async trialBalance(tenant: Tenant, from?: string, to?: string) {
    const conditions = [eq(accountingEntries.businessId, tenant.businessId)];
    if (from) conditions.push(gte(accountingEntries.entryDate, dateOnly(from)));
    if (to) conditions.push(lte(accountingEntries.entryDate, dateOnly(to)));
    const rows = await this.database.db.select({
      accountId: accountingEntryLines.accountId,
      accountNumber: accountingAccounts.accountNumber,
      accountLabel: accountingAccounts.label,
      debit: sql<string>`sum(${accountingEntryLines.debit})`,
      credit: sql<string>`sum(${accountingEntryLines.credit})`,
    }).from(accountingEntryLines)
      .innerJoin(accountingEntries, and(
        eq(accountingEntries.id, accountingEntryLines.entryId),
        eq(accountingEntries.businessId, accountingEntryLines.businessId),
      ))
      .innerJoin(accountingAccounts, and(
        eq(accountingAccounts.id, accountingEntryLines.accountId),
        eq(accountingAccounts.businessId, accountingEntryLines.businessId),
      ))
      .where(and(...conditions))
      .groupBy(accountingEntryLines.accountId, accountingAccounts.accountNumber, accountingAccounts.label)
      .orderBy(asc(accountingAccounts.accountNumber));
    return rows;
  }

  private async loadEntry(executor: any, businessId: string, entryId: string) {
    const [entry] = await executor.select().from(accountingEntries).where(and(
      eq(accountingEntries.id, entryId),
      eq(accountingEntries.businessId, businessId),
    )).limit(1);
    if (!entry) throw new NotFoundException('Accounting entry not found');
    const lines = await executor.select().from(accountingEntryLines).where(and(
      eq(accountingEntryLines.entryId, entryId),
      eq(accountingEntryLines.businessId, businessId),
    )).orderBy(asc(accountingEntryLines.lineNumber));
    return { ...entry, lines };
  }
}

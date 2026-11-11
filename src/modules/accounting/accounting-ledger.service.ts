import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { accountingAmountToMinorUnits, minorUnitsToAccountingAmount } from './accounting-money';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  accountingAccounts,
  accountingEntries,
  accountingEntryLines,
  accountingJournals,
  accountingPeriods,
  customers,
  suppliers,
} from '../../infrastructure/database/schema';
import { Tenant } from '../auth/tenant.type';

type EntryLineInput = {
  accountId: string;
  description?: string;
  debit?: string | number;
  credit?: string | number;
  auxiliaryType?: 'CUSTOMER' | 'SUPPLIER';
  auxiliaryId?: string;
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

function validateDateRange(from?: string, to?: string): { from?: string; to?: string } {
  const normalizedFrom = from === undefined ? undefined : dateOnly(from);
  const normalizedTo = to === undefined ? undefined : dateOnly(to);
  if (normalizedFrom && normalizedTo && normalizedFrom > normalizedTo) {
    throw new BadRequestException('from must not be later than to');
  }
  return { from: normalizedFrom, to: normalizedTo };
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
    if (input.idempotencyKey && input.idempotencyKey.length > 120) throw new BadRequestException('idempotencyKey is too long');

    const normalized = input.lines.map((line, index) => {
      const debit = accountingAmountToMinorUnits(line.debit, `lines[${index}].debit`);
      const credit = accountingAmountToMinorUnits(line.credit, `lines[${index}].credit`);
      if ((debit > 0n) === (credit > 0n)) {
        throw new BadRequestException(`Line ${index + 1} must contain either a debit or a credit, not both`);
      }
      if (Boolean(line.auxiliaryType) !== Boolean(line.auxiliaryId)) throw new BadRequestException(`Line ${index + 1}: auxiliaryType and auxiliaryId must be supplied together`);
      if (line.auxiliaryType && !['CUSTOMER', 'SUPPLIER'].includes(line.auxiliaryType)) throw new BadRequestException(`Line ${index + 1}: invalid auxiliaryType`);
      return { accountId: line.accountId, description: line.description?.trim() || null, debit, credit, auxiliaryType: line.auxiliaryType, auxiliaryId: line.auxiliaryId };
    });
    const debitTotal = normalized.reduce((sum, line) => sum + line.debit, 0n);
    const creditTotal = normalized.reduce((sum, line) => sum + line.credit, 0n);
    if (debitTotal === 0n || debitTotal !== creditTotal) {
      throw new BadRequestException('Accounting entry is not balanced: total debits must equal total credits and be positive');
    }

    const requestHash = createHash('sha256').update(JSON.stringify({
      journalId: input.journalId,
      periodId: input.periodId,
      entryDate,
      description,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      lines: normalized.map((line) => ({
        accountId: line.accountId,
        description: line.description,
        debit: line.debit.toString(),
        credit: line.credit.toString(),
        auxiliaryType: line.auxiliaryType ?? null,
        auxiliaryId: line.auxiliaryId ?? null,
      })),
    })).digest('hex');
    return this.database.db.transaction(async (tx) => {
      // Serialize duplicate requests before checking the unique idempotency/source indexes.
      if (input.idempotencyKey) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.businessId}), hashtext(${'accounting-idempotency:' + input.idempotencyKey}))`);
      }
      if (input.sourceType && input.sourceId) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenant.businessId}), hashtext(${'accounting-source:' + input.sourceType + ':' + input.sourceId}))`);
      }
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
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('Source reference was reused with a different accounting payload');
          }
          return this.loadEntry(tx, tenant.businessId, existing.id);
        }
      }

      const [journal] = await tx.select().from(accountingJournals).where(and(
        eq(accountingJournals.id, input.journalId),
        eq(accountingJournals.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!journal || !journal.isActive) throw new BadRequestException('Active journal not found in this business');

      const [period] = await tx.select().from(accountingPeriods).where(and(
        eq(accountingPeriods.id, input.periodId),
        eq(accountingPeriods.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!period) throw new NotFoundException('Accounting period not found');
      if (period.status !== 'OPEN') throw new ConflictException('Accounting period is not open');
      if (entryDate < period.startDate || entryDate > period.endDate) {
        throw new BadRequestException('entryDate must fall within the selected accounting period');
      }

      const customerIds = [...new Set(normalized.filter((line) => line.auxiliaryType === 'CUSTOMER').map((line) => line.auxiliaryId!))];
      if (customerIds.length) {
        const foundCustomers = await tx.select({ id: customers.id }).from(customers).where(and(
          eq(customers.businessId, tenant.businessId), inArray(customers.id, customerIds),
        ));
        if (foundCustomers.length !== customerIds.length) {
          throw new BadRequestException('One or more customer auxiliaries do not belong to this business');
        }
      }
      const supplierIds = [...new Set(normalized.filter((line) => line.auxiliaryType === 'SUPPLIER').map((line) => line.auxiliaryId!))];
      if (supplierIds.length) {
        const foundSuppliers = await tx.select({ id: suppliers.id }).from(suppliers).where(and(
          eq(suppliers.businessId, tenant.businessId), inArray(suppliers.id, supplierIds),
        ));
        if (foundSuppliers.length !== supplierIds.length) {
          throw new BadRequestException('One or more supplier auxiliaries do not belong to this business');
        }
      }

      const accountIds = [...new Set(normalized.map((line) => line.accountId))];
      const accounts = await tx.select().from(accountingAccounts).where(and(
        eq(accountingAccounts.businessId, tenant.businessId),
        inArray(accountingAccounts.id, accountIds),
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
      if (!sequence) throw new ConflictException('Could not allocate an accounting journal sequence');
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

      if (!entry) throw new ConflictException('Could not create accounting entry');
      await tx.insert(accountingEntryLines).values(normalized.map((line, index) => ({
        businessId: tenant.businessId,
        entryId: entry.id,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description,
        customerId: line.auxiliaryType === 'CUSTOMER' ? line.auxiliaryId : null,
        supplierId: line.auxiliaryType === 'SUPPLIER' ? line.auxiliaryId : null,
        debit: minorUnitsToAccountingAmount(line.debit),
        credit: minorUnitsToAccountingAmount(line.credit),
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
      )).for('update').limit(1);
      if (!original) throw new NotFoundException('Accounting entry not found');
      if (original.status !== 'POSTED') throw new ConflictException('Only a posted accounting entry can be reversed');
      const entryDate = dateOnly(reversalDate);
      if (entryDate < original.entryDate) throw new BadRequestException('A reversal date cannot precede the original entry date');
      // Keep the lock order consistent with createAndPost: journal, then period.
      const [journal] = await tx.select().from(accountingJournals).where(and(
        eq(accountingJournals.id, original.journalId), eq(accountingJournals.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!journal || !journal.isActive) throw new ConflictException('Original journal is not active');
      const [period] = await tx.select().from(accountingPeriods).where(and(
        eq(accountingPeriods.id, periodId), eq(accountingPeriods.businessId, tenant.businessId),
      )).for('update').limit(1);
      if (!period || period.status !== 'OPEN') throw new ConflictException('Reversal requires an open accounting period');
      if (entryDate < period.startDate || entryDate > period.endDate) throw new BadRequestException('Reversal date must fall within the selected open period');
      const [existingReversal] = await tx.select({ id: accountingEntries.id }).from(accountingEntries).where(and(
        eq(accountingEntries.businessId, tenant.businessId),
        eq(accountingEntries.reversalOfEntryId, original.id),
      )).limit(1);
      if (existingReversal) throw new ConflictException('This accounting entry has already been reversed');
      const [sequence] = await tx.update(accountingJournals).set({
        nextSequence: sql`${accountingJournals.nextSequence} + 1`, updatedAt: new Date(),
      }).where(and(eq(accountingJournals.id, journal.id), eq(accountingJournals.businessId, tenant.businessId)))
        .returning({ allocated: sql<number>`${accountingJournals.nextSequence} - 1` });
      if (!sequence) throw new ConflictException('Could not allocate an accounting journal sequence');
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
      if (!reversal) throw new ConflictException('Could not create reversal entry');
      await tx.insert(accountingEntryLines).values(lines.map((line, index) => ({
        businessId: tenant.businessId,
        entryId: reversal.id,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description,
        customerId: line.customerId,
        supplierId: line.supplierId,
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
    const requestedLimit = filters.limit ?? 50;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw new BadRequestException('limit must be a positive integer');
    const limit = Math.min(requestedLimit, 200);
    const range = validateDateRange(filters.from, filters.to);
    const conditions = [eq(accountingEntries.businessId, tenant.businessId), eq(accountingEntries.status, 'POSTED')];
    if (range.from) conditions.push(gte(accountingEntries.entryDate, range.from));
    if (range.to) conditions.push(lte(accountingEntries.entryDate, range.to));
    if (filters.periodId) conditions.push(eq(accountingEntries.periodId, filters.periodId));
    const entries = await this.database.db.select().from(accountingEntries)
      .where(and(...conditions)).orderBy(desc(accountingEntries.entryDate), desc(accountingEntries.entryNumber)).limit(limit);
    return Promise.all(entries.map((entry) => this.loadEntry(this.database.db, tenant.businessId, entry.id)));
  }

  async ledger(tenant: Tenant, accountId: string, from?: string, to?: string) {
    const range = validateDateRange(from, to);
    const conditions = [
      eq(accountingEntryLines.businessId, tenant.businessId),
      eq(accountingEntryLines.accountId, accountId),
      eq(accountingEntries.status, 'POSTED'),
    ];
    if (range.from) conditions.push(gte(accountingEntries.entryDate, range.from));
    if (range.to) conditions.push(lte(accountingEntries.entryDate, range.to));
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
      debit += accountingAmountToMinorUnits(row.debit, 'debit');
      credit += accountingAmountToMinorUnits(row.credit, 'credit');
      return { ...row, runningDebit: minorUnitsToAccountingAmount(debit), runningCredit: minorUnitsToAccountingAmount(credit), balance: minorUnitsToAccountingAmount(debit - credit) };
    });
  }

  async trialBalance(tenant: Tenant, from?: string, to?: string) {
    const range = validateDateRange(from, to);
    const conditions = [eq(accountingEntries.businessId, tenant.businessId), eq(accountingEntries.status, 'POSTED')];
    if (range.from) conditions.push(gte(accountingEntries.entryDate, range.from));
    if (range.to) conditions.push(lte(accountingEntries.entryDate, range.to));
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
    const totalDebit = rows.reduce((sum, row) => sum + accountingAmountToMinorUnits(row.debit), 0n);
    const totalCredit = rows.reduce((sum, row) => sum + accountingAmountToMinorUnits(row.credit), 0n);
    return {
      rows,
      totals: {
        debit: minorUnitsToAccountingAmount(totalDebit),
        credit: minorUnitsToAccountingAmount(totalCredit),
        balanced: totalDebit === totalCredit,
      },
    };
  }


  async auxiliaryLedger(tenant: Tenant, type: 'CUSTOMER' | 'SUPPLIER', auxiliaryId: string, from?: string, to?: string) {
    const range = validateDateRange(from, to);
    const column = type === 'CUSTOMER' ? accountingEntryLines.customerId : accountingEntryLines.supplierId;
    const conditions = [
      eq(accountingEntryLines.businessId, tenant.businessId),
      eq(column, auxiliaryId),
      eq(accountingEntries.status, 'POSTED'),
    ];
    if (range.from) conditions.push(gte(accountingEntries.entryDate, range.from));
    if (range.to) conditions.push(lte(accountingEntries.entryDate, range.to));
    const rows = await this.database.db.select({
      entryId: accountingEntries.id, entryNumber: accountingEntries.entryNumber,
      entryDate: accountingEntries.entryDate, description: accountingEntries.description,
      accountId: accountingEntryLines.accountId, debit: accountingEntryLines.debit,
      credit: accountingEntryLines.credit,
    }).from(accountingEntryLines).innerJoin(accountingEntries, and(
      eq(accountingEntries.id, accountingEntryLines.entryId),
      eq(accountingEntries.businessId, accountingEntryLines.businessId),
    )).where(and(...conditions)).orderBy(asc(accountingEntries.entryDate), asc(accountingEntries.entryNumber), asc(accountingEntryLines.lineNumber));
    let debit = 0n, credit = 0n;
    return rows.map((row) => {
      debit += accountingAmountToMinorUnits(row.debit);
      credit += accountingAmountToMinorUnits(row.credit);
      return { ...row, cumulativeDebit: minorUnitsToAccountingAmount(debit), cumulativeCredit: minorUnitsToAccountingAmount(credit), balance: minorUnitsToAccountingAmount(debit-credit) };
    });
  }

  async openingBalance(tenant: Tenant, input: CreateEntryInput, actorId?: string) {
    const sourceId = input.sourceId ?? input.idempotencyKey;
    if (!sourceId) {
      throw new BadRequestException('Opening balances require an idempotencyKey or an explicit sourceId');
    }
    const [journal] = await this.database.db.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, input.journalId), eq(accountingJournals.businessId, tenant.businessId),
    )).limit(1);
    if (!journal || journal.journalType !== 'OPENING' || !journal.isActive) {
      throw new BadRequestException('An active OPENING journal belonging to this business is required');
    }
    return this.createAndPost(tenant, { ...input, sourceType: 'OPENING', sourceId }, actorId);
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

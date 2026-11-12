import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  accountingAccounts,
  accountingEntries,
  accountingEntryLines,
  accountingEventMappingLines,
  accountingEventMappings,
  accountingJournals,
  accountingPeriods,
  customers,
  suppliers,
} from '../../infrastructure/database/schema';
import { accountingAmountToMinorUnits, minorUnitsToAccountingAmount } from './accounting-money';
import { Tenant } from '../auth/tenant.type';

type AmountBasis =
  | 'EXPENSE_AMOUNT'
  | 'SALE_TOTAL'
  | 'SALE_SUBTOTAL'
  | 'SALE_DISCOUNT'
  | 'SALE_COST_AT_SALE';

type OperationalLine = {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amountBasis: AmountBasis;
  percentage: string | number;
  auxiliaryType: 'CUSTOMER' | 'SUPPLIER' | null;
};

type PostingEvent = {
  sourceType: 'EXPENSE' | 'SALE';
  sourceCategory: string;
  sourceId: string;
  entryDate: string;
  description: string;
  locationId: string;
  customerId?: string | null;
  supplierId?: string | null;
  baseAmounts: Partial<Record<AmountBasis, bigint>>;
  unavailableBases?: AmountBasis[];
};

function percentageToBasisPoints(value: string | number): bigint {
  const raw = String(value);
  if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(raw)) {
    throw new ConflictException('An accounting template contains an invalid percentage');
  }
  const [whole, fraction = ''] = raw.split('.');
  const basisPoints = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  if (basisPoints <= 0n || basisPoints > 1_000_000n) {
    throw new ConflictException('An accounting template percentage must be greater than 0 and at most 100');
  }
  return basisPoints;
}

function applyPercentage(amount: bigint, percentage: string | number): bigint {
  const basisPoints = percentageToBasisPoints(percentage);
  // Round half-up to the currency's minor unit using integer arithmetic.
  return (amount * basisPoints + 5_000n) / 10_000n;
}

@Injectable()
export class AccountingOperationalPostingService {
  constructor(private readonly database: DatabaseService) {}

  async postExpense(tx: any, tenant: Tenant, expense: {
    id: string;
    locationId: string;
    category: string;
    amount: string;
    description: string | null;
    createdAt: Date;
  }) {
    const sourceCategory = expense.category.trim().toLocaleLowerCase('fr-FR');
    const amount = accountingAmountToMinorUnits(expense.amount, 'expense.amount');
    if (amount <= 0n) throw new ConflictException('Expense amount must be positive for accounting');

    return this.postMappedEvent(tx, tenant, {
      sourceType: 'EXPENSE',
      sourceCategory,
      sourceId: expense.id,
      entryDate: expense.createdAt.toISOString().slice(0, 10),
      description: `Dépense ${sourceCategory}: ${expense.description ?? ''}`.slice(0, 240),
      locationId: expense.locationId,
      baseAmounts: { EXPENSE_AMOUNT: amount },
    });
  }

  async postSale(tx: any, tenant: Tenant, sale: {
    id: string;
    locationId: string;
    customerId: string | null;
    subtotal: string;
    discount: string;
    total: string;
    createdAt: Date;
  }, items: Array<{ quantity: number; costAtSale: string | null }>) {
    let costAtSale = 0n;
    const unavailableBases: AmountBasis[] = [];
    for (const item of items) {
      if (item.costAtSale === null) {
        unavailableBases.push('SALE_COST_AT_SALE');
        continue;
      }
      costAtSale += accountingAmountToMinorUnits(item.costAtSale, 'saleItem.costAtSale') * BigInt(item.quantity);
    }

    return this.postMappedEvent(tx, tenant, {
      sourceType: 'SALE',
      sourceCategory: 'default',
      sourceId: sale.id,
      entryDate: sale.createdAt.toISOString().slice(0, 10),
      description: `Vente ${sale.id}`,
      locationId: sale.locationId,
      customerId: sale.customerId,
      baseAmounts: {
        SALE_TOTAL: accountingAmountToMinorUnits(sale.total, 'sale.total'),
        SALE_SUBTOTAL: accountingAmountToMinorUnits(sale.subtotal, 'sale.subtotal'),
        SALE_DISCOUNT: accountingAmountToMinorUnits(sale.discount, 'sale.discount'),
        SALE_COST_AT_SALE: costAtSale,
      },
      unavailableBases: unavailableBases.length ? ['SALE_COST_AT_SALE'] : [],
    });
  }

  private async postMappedEvent(tx: any, tenant: Tenant, event: PostingEvent) {
    const [mapping] = await tx.select().from(accountingEventMappings).where(and(
      eq(accountingEventMappings.businessId, tenant.businessId),
      eq(accountingEventMappings.sourceType, event.sourceType),
      eq(accountingEventMappings.sourceCategory, event.sourceCategory),
      eq(accountingEventMappings.isActive, true),
    )).limit(1);
    if (!mapping) return { status: 'NOT_CONFIGURED' as const, entryId: null };

    const lines = await tx.select().from(accountingEventMappingLines).where(and(
      eq(accountingEventMappingLines.businessId, tenant.businessId),
      eq(accountingEventMappingLines.mappingId, mapping.id),
    )).orderBy(asc(accountingEventMappingLines.lineNumber));
    if (lines.length < 2) throw new ConflictException('The configured accounting template must contain at least two lines');

    // An already-posted source event is immutable. Replays return its original
    // accounting result even if the tenant later changes its template.
    const [existing] = await tx.select({
      id: accountingEntries.id,
      entryNumber: accountingEntries.entryNumber,
    }).from(accountingEntries).where(and(
      eq(accountingEntries.businessId, tenant.businessId),
      eq(accountingEntries.sourceType, event.sourceType),
      eq(accountingEntries.sourceId, event.sourceId),
    )).limit(1);
    if (existing) {
      return { status: 'POSTED' as const, entryId: existing.id, entryNumber: existing.entryNumber, replayed: true };
    }

    const normalized: Array<{
      accountId: string;
      side: 'DEBIT' | 'CREDIT';
      amount: bigint;
      auxiliaryType: 'CUSTOMER' | 'SUPPLIER' | null;
      auxiliaryId: string | null;
    }> = [];

    for (const line of lines as OperationalLine[]) {
      if (event.unavailableBases?.includes(line.amountBasis)) {
        throw new ConflictException(`Accounting basis ${line.amountBasis} is unavailable for this source record`);
      }
      const base = event.baseAmounts[line.amountBasis];
      if (base === undefined || base < 0n) {
        throw new ConflictException(`Accounting basis ${line.amountBasis} is not available for this event`);
      }
      const amount = applyPercentage(base, line.percentage);
      // Zero-valued components (for example, a zero discount) do not create
      // zero-value journal lines, which PostgreSQL correctly rejects.
      if (amount === 0n) continue;
      const auxiliaryId = line.auxiliaryType === 'CUSTOMER'
        ? event.customerId ?? null
        : line.auxiliaryType === 'SUPPLIER'
          ? event.supplierId ?? null
          : null;
      if (line.auxiliaryType && !auxiliaryId) {
        throw new ConflictException(`The accounting template requires a ${line.auxiliaryType.toLowerCase()} auxiliary that is absent from the source event`);
      }
      normalized.push({
        accountId: (line as any).accountId,
        side: (line as any).side,
        amount,
        auxiliaryType: (line as any).auxiliaryType ?? null,
        auxiliaryId,
      });
    }

    if (normalized.length < 2) throw new ConflictException('The accounting template resolved to fewer than two non-zero lines');
    const debitTotal = normalized.reduce((sum, line) => sum + (line.side === 'DEBIT' ? line.amount : 0n), 0n);
    const creditTotal = normalized.reduce((sum, line) => sum + (line.side === 'CREDIT' ? line.amount : 0n), 0n);
    if (debitTotal <= 0n || debitTotal !== creditTotal) {
      throw new ConflictException('The configured accounting template is not balanced for this transaction');
    }

    const accountIds = [...new Set(normalized.map((line) => line.accountId))];
    const accounts = await tx.select().from(accountingAccounts).where(and(
      eq(accountingAccounts.businessId, tenant.businessId),
      inArray(accountingAccounts.id, accountIds),
    ));
    if (accounts.length !== accountIds.length || accounts.some((account: { isActive: boolean; isPostable: boolean }) => !account.isActive || !account.isPostable)) {
      throw new ConflictException('One or more configured accounting accounts are inactive, non-postable, or outside this business');
    }

    const customerIds = [...new Set(normalized.filter((line) => line.auxiliaryType === 'CUSTOMER').map((line) => line.auxiliaryId!))];
    if (customerIds.length) {
      const found = await tx.select({ id: customers.id }).from(customers).where(and(
        eq(customers.businessId, tenant.businessId), inArray(customers.id, customerIds),
      ));
      if (found.length !== customerIds.length) throw new ConflictException('A configured customer auxiliary does not belong to this business');
    }
    const supplierIds = [...new Set(normalized.filter((line) => line.auxiliaryType === 'SUPPLIER').map((line) => line.auxiliaryId!))];
    if (supplierIds.length) {
      const found = await tx.select({ id: suppliers.id }).from(suppliers).where(and(
        eq(suppliers.businessId, tenant.businessId), inArray(suppliers.id, supplierIds),
      ));
      if (found.length !== supplierIds.length) throw new ConflictException('A configured supplier auxiliary does not belong to this business');
    }

    // Lock order is journal -> period, consistent with manual postings and reversals.
    const [journal] = await tx.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, mapping.journalId),
      eq(accountingJournals.businessId, tenant.businessId),
      eq(accountingJournals.isActive, true),
    )).for('update').limit(1);
    if (!journal) throw new ConflictException('The configured accounting journal is no longer active');

    const [period] = await tx.select().from(accountingPeriods).where(and(
      eq(accountingPeriods.businessId, tenant.businessId),
      lte(accountingPeriods.startDate, event.entryDate),
      gte(accountingPeriods.endDate, event.entryDate),
    )).for('update').limit(1);
    if (!period || period.status !== 'OPEN') {
      throw new ConflictException('An automatically posted event requires an open accounting period covering its date');
    }

    const requestHash = createHash('sha256').update(JSON.stringify({
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      entryDate: event.entryDate,
      locationId: event.locationId,
      description: event.description,
      lines: normalized.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount.toString(),
        auxiliaryType: line.auxiliaryType,
        auxiliaryId: line.auxiliaryId,
      })),
    })).digest('hex');

    const [sequence] = await tx.update(accountingJournals).set({
      nextSequence: sql`${accountingJournals.nextSequence} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(accountingJournals.id, journal.id),
      eq(accountingJournals.businessId, tenant.businessId),
    )).returning({ allocated: sql<number>`${accountingJournals.nextSequence} - 1` });
    if (!sequence) throw new ConflictException('Could not allocate an accounting journal sequence');

    const [entry] = await tx.insert(accountingEntries).values({
      businessId: tenant.businessId,
      journalId: journal.id,
      periodId: period.id,
      locationId: event.locationId,
      entryNumber: `${journal.sequencePrefix}${String(sequence.allocated).padStart(6, '0')}`,
      entryDate: event.entryDate,
      description: event.description.slice(0, 240),
      status: 'DRAFT',
      sourceType: event.sourceType,
      sourceId: event.sourceId,
      requestHash,
      createdBy: tenant.userId,
    }).returning();
    if (!entry) throw new ConflictException('Could not create the operational accounting entry');

    await tx.insert(accountingEntryLines).values(normalized.map((line, index) => ({
      businessId: tenant.businessId,
      entryId: entry.id,
      lineNumber: index + 1,
      accountId: line.accountId,
      customerId: line.auxiliaryType === 'CUSTOMER' ? line.auxiliaryId : null,
      supplierId: line.auxiliaryType === 'SUPPLIER' ? line.auxiliaryId : null,
      debit: line.side === 'DEBIT' ? minorUnitsToAccountingAmount(line.amount) : '0.00',
      credit: line.side === 'CREDIT' ? minorUnitsToAccountingAmount(line.amount) : '0.00',
    })));

    const [posted] = await tx.update(accountingEntries).set({ status: 'POSTED' }).where(and(
      eq(accountingEntries.id, entry.id),
      eq(accountingEntries.businessId, tenant.businessId),
    )).returning({ id: accountingEntries.id, entryNumber: accountingEntries.entryNumber });
    return { status: 'POSTED' as const, entryId: posted?.id ?? entry.id, entryNumber: posted?.entryNumber ?? entry.entryNumber };
  }
}

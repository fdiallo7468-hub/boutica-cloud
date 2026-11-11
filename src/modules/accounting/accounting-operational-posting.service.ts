import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { accountingAccounts, accountingEntries, accountingEntryLines, accountingEventMappings, accountingJournals, accountingPeriods } from '../../infrastructure/database/schema';
import { accountingAmountToMinorUnits, minorUnitsToAccountingAmount } from './accounting-money';
import { Tenant } from '../auth/tenant.type';

@Injectable()
export class AccountingOperationalPostingService {
  constructor(private readonly database: DatabaseService) {}

  async postExpense(tx: any, tenant: Tenant, expense: {
    id: string; category: string; amount: string; description: string | null; createdAt: Date;
  }) {
    const sourceCategory = expense.category.trim().toLocaleLowerCase('fr-FR');
    const [mapping] = await tx.select().from(accountingEventMappings).where(and(
      eq(accountingEventMappings.businessId, tenant.businessId),
      eq(accountingEventMappings.sourceType, 'EXPENSE'),
      eq(accountingEventMappings.sourceCategory, sourceCategory),
      eq(accountingEventMappings.isActive, true),
    )).limit(1);
    if (!mapping) return { status: 'NOT_CONFIGURED' as const, entryId: null };

    const entryDate = expense.createdAt.toISOString().slice(0, 10);
    const [period] = await tx.select().from(accountingPeriods).where(and(
      eq(accountingPeriods.businessId, tenant.businessId),
      lte(accountingPeriods.startDate, entryDate),
      gte(accountingPeriods.endDate, entryDate),
    )).for('update').limit(1);
    if (!period || period.status !== 'OPEN') throw new ConflictException('A mapped expense requires an open accounting period covering its date');
    const [journal] = await tx.select().from(accountingJournals).where(and(
      eq(accountingJournals.id, mapping.journalId), eq(accountingJournals.businessId, tenant.businessId),
      eq(accountingJournals.isActive, true),
    )).for('update').limit(1);
    if (!journal) throw new ConflictException('The configured expense journal is no longer active');

    const accounts = await tx.select().from(accountingAccounts).where(and(
      eq(accountingAccounts.businessId, tenant.businessId),
      sql`${accountingAccounts.id} IN (${sql.join([sql`${mapping.debitAccountId}::uuid`, sql`${mapping.creditAccountId}::uuid`], sql`, `)})`,
    ));
    if (accounts.length !== 2 || accounts.some((account: { isActive: boolean; isPostable: boolean }) => !account.isActive || !account.isPostable)) {
      throw new ConflictException('A configured expense account is inactive or not postable');
    }
    const amount = accountingAmountToMinorUnits(expense.amount, 'expense.amount');
    if (amount <= 0n) throw new ConflictException('Expense amount must be positive for accounting');
    const [sequence] = await tx.update(accountingJournals).set({
      nextSequence: sql`${accountingJournals.nextSequence} + 1`, updatedAt: new Date(),
    }).where(and(eq(accountingJournals.id, journal.id), eq(accountingJournals.businessId, tenant.businessId)))
      .returning({ allocated: sql<number>`${accountingJournals.nextSequence} - 1` });
    if (!sequence) throw new ConflictException('Could not allocate an accounting journal sequence');

    const [entry] = await tx.insert(accountingEntries).values({
      businessId: tenant.businessId, journalId: journal.id, periodId: period.id,
      entryNumber: `${journal.sequencePrefix}${String(sequence.allocated).padStart(6, '0')}`,
      entryDate, description: `Dépense ${sourceCategory}: ${expense.description ?? ''}`.slice(0, 240),
      status: 'DRAFT', sourceType: 'EXPENSE', sourceId: expense.id, createdBy: tenant.userId,
    }).returning();
    if (!entry) throw new ConflictException('Could not create expense accounting entry');
    const value = minorUnitsToAccountingAmount(amount);
    await tx.insert(accountingEntryLines).values([
      { businessId: tenant.businessId, entryId: entry.id, lineNumber: 1, accountId: mapping.debitAccountId, description: 'Charge', debit: value, credit: '0.00' },
      { businessId: tenant.businessId, entryId: entry.id, lineNumber: 2, accountId: mapping.creditAccountId, description: 'Règlement de la charge', debit: '0.00', credit: value },
    ]);
    const [posted] = await tx.update(accountingEntries).set({ status: 'POSTED' }).where(and(
      eq(accountingEntries.id, entry.id), eq(accountingEntries.businessId, tenant.businessId),
    )).returning({ id: accountingEntries.id, entryNumber: accountingEntries.entryNumber });
    return { status: 'POSTED' as const, entryId: posted?.id ?? entry.id, entryNumber: posted?.entryNumber ?? entry.entryNumber };
  }
}

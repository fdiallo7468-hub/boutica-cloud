import { Body, Controller, Get, NotFoundException, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { businesses, businessLocations, expenses } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { Money } from '../../common/domain';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { Expense } from './domain/expense';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { AccountingOperationalPostingService } from '../accounting/accounting-operational-posting.service';

@ApiTags('expenses')
@Controller('api/v1/expenses')
export class ExpensesController {
  constructor(private readonly db: DatabaseService, private readonly accountingPosting: AccountingOperationalPostingService) {}

  // ROUND 2 FIX: this module had a POST but no way to ever list what had
  // been recorded — the brief is explicit that expenses need to be
  // manageable (section 6), and a write-only ledger isn't. Mirrors the
  // same pagination pattern already used by catalog/customers.
  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQueryDto) {
    const filter = eq(expenses.businessId, tenant.businessId);
    const [data, countResult] = await Promise.all([
      this.db.db.select().from(expenses).where(filter).orderBy(desc(expenses.createdAt)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(expenses).where(filter),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateExpenseDto) {
    // ROUND 2 FIX: same currency-consistency fix as catalog.controller.ts —
    // Money used to silently default to XOF instead of the business's
    // configured currency.
    const [business] = await this.db.db.select({ currency: businesses.currency }).from(businesses).where(eq(businesses.id, tenant.businessId));
    const amount = Money.fromDecimal(body.amount, business?.currency ?? 'XOF');
    const [location] = await this.db.db.select({ id: businessLocations.id }).from(businessLocations).where(and(
      eq(businessLocations.businessId, tenant.businessId),
      eq(businessLocations.isDefault, true),
      eq(businessLocations.isActive, true),
    ));
    if (!location) throw new NotFoundException('Aucune localisation active par défaut n’est configurée');
    const expense = Expense.create(randomUUID(), tenant.businessId, body.category, amount, body.description);

    return this.db.db.transaction(async (tx) => {
      const [row] = await tx.insert(expenses).values({
        businessId: expense.businessId,
        locationId: location.id,
        category: expense.category,
        amount: expense.amount.toDecimalString(),
        description: expense.description,
      }).returning();
      if (!row) throw new NotFoundException('La dépense n’a pas pu être enregistrée');
      const accounting = await this.accountingPosting.postExpense(tx, tenant, row);
      return { ...row, accounting };
    });
  }
}

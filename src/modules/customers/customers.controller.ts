import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq, ilike, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { businessLocations, customers, sales } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('customers')
@Controller('api/v1/customers')
export class CustomersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(
    @CurrentTenant() tenant: Tenant,
    @Query() query: PaginationQueryDto,
    @Query('includeArchived') includeArchived?: string,
    @Query('search') search?: string,
  ) {
    const filters = [eq(customers.businessId, tenant.businessId)];
    if (includeArchived !== 'true') filters.push(eq(customers.isActive, true));
    const normalizedSearch = search?.trim();
    if (normalizedSearch) {
      const escapedSearch = normalizedSearch.replace(/[\\%_]/g, '\\      const pattern = `%${normalizedSearch}%`;');
      const pattern = `%${escapedSearch}%`;
      filters.push(or(ilike(customers.name, pattern), ilike(customers.phone, pattern))!);
    }

    const [data, countResult] = await Promise.all([
      this.db.db.select().from(customers).where(and(...filters)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(customers).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id/history')
  async history(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('locationId') locationId?: string,
    @Query('limit') limit = '20',
    @Query('offset') offset = '0',
  ) {
    const [customer] = await this.db.db.select({ id: customers.id }).from(customers).where(and(
      eq(customers.id, id), eq(customers.businessId, tenant.businessId),
    ));
    if (!customer) throw new NotFoundException('Customer not found');
    const start = from ? new Date(from) : undefined;
    const end = to ? new Date(to) : undefined;
    const pageSize = Number(limit);
    const pageOffset = Number(offset);
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())) ||
      (start && end && start > end) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isInteger(pageOffset) || pageOffset < 0) {
      throw new BadRequestException('Invalid customer history filters');
    }
    const filters = [eq(sales.businessId, tenant.businessId), eq(sales.customerId, id), eq(sales.status, 'COMPLETED')];
    if (start) filters.push(gte(sales.createdAt, start));
    if (end) filters.push(lte(sales.createdAt, end));
    if (locationId) {
      const [location] = await this.db.db.select({ id: businessLocations.id }).from(businessLocations).where(and(
        eq(businessLocations.id, locationId), eq(businessLocations.businessId, tenant.businessId), eq(businessLocations.isActive, true),
      ));
      if (!location) throw new NotFoundException('Location not found');
      filters.push(eq(sales.locationId, locationId));
    }
    const [data, countResult] = await Promise.all([
      this.db.db.select().from(sales).where(and(...filters)).orderBy(sql`${sales.createdAt} DESC`).limit(pageSize).offset(pageOffset),
      this.db.db.select({ value: count() }).from(sales).where(and(...filters)),
    ]);
    return { customerId: id, data, total: countResult[0]?.value ?? 0, limit: pageSize, offset: pageOffset };
  }

  @Get(':id/summary')
  async summary(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [customer] = await this.db.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.businessId, tenant.businessId)));
    if (!customer) throw new NotFoundException('Customer not found');

    const [metrics] = await this.db.db
      .select({
        completedSalesCount: count(),
        lifetimeValue: sql<string>`coalesce(sum(${sales.total}), 0)::text`,
        averageBasket: sql<string>`coalesce(round(avg(${sales.total}), 2), 0)::text`,
        lastPurchaseAt: sql<Date | null>`max(${sales.createdAt})`,
      })
      .from(sales)
      .where(and(
        eq(sales.businessId, tenant.businessId),
        eq(sales.customerId, id),
        eq(sales.status, 'COMPLETED'),
      ));

    return {
      customerId: customer.id,
      completedSalesCount: metrics?.completedSalesCount ?? 0,
      lifetimeValue: metrics?.lifetimeValue ?? '0',
      averageBasket: metrics?.averageBasket ?? '0',
      lastPurchaseAt: metrics?.lastPurchaseAt ?? null,
    };
  }

  @Get('segments')
  async segments(@CurrentTenant() tenant: Tenant) {
    const rows = await this.db.db
      .select({
        customerId: customers.id,
        name: customers.name,
        phone: customers.phone,
        createdAt: customers.createdAt,
        completedSalesCount: count(sales.id),
        lifetimeValue: sql<string>`coalesce(sum(${sales.total}), 0)::text`,
        lastPurchaseAt: sql<Date | null>`max(${sales.createdAt})`,
      })
      .from(customers)
      .leftJoin(sales, and(
        eq(sales.customerId, customers.id),
        eq(sales.businessId, tenant.businessId),
        eq(sales.status, 'COMPLETED'),
      ))
      .where(and(eq(customers.businessId, tenant.businessId), eq(customers.isActive, true)))
      .groupBy(customers.id);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const segments = { new: [] as typeof rows, active: [] as typeof rows, atRisk: [] as typeof rows, inactive: [] as typeof rows, highValue: [] as typeof rows };
    for (const row of rows) {
      const lastPurchase = row.lastPurchaseAt ? new Date(row.lastPurchaseAt).getTime() : null;
      const daysSincePurchase = lastPurchase === null ? null : Math.floor((now - lastPurchase) / day);
      if (Number(row.lifetimeValue) >= 250000) segments.highValue.push(row);
      if (daysSincePurchase === null && now - new Date(row.createdAt).getTime() <= 30 * day) {
        segments.new.push(row);
      } else if (daysSincePurchase === null || daysSincePurchase > 90) {
        segments.inactive.push(row);
      } else if (daysSincePurchase > 30) {
        segments.atRisk.push(row);
      } else {
        segments.active.push(row);
      }
    }

    return {
      rules: { newCustomerDays: 30, activePurchaseDays: 30, atRiskAfterDays: 30, inactiveAfterDays: 90, highValueLifetimeSpend: '250000.00' },
      counts: {
        new: segments.new.length,
        active: segments.active.length,
        atRisk: segments.atRisk.length,
        inactive: segments.inactive.length,
        highValue: segments.highValue.length,
      },
      customers: segments,
    };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [customer] = await this.db.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.businessId, tenant.businessId)));
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateCustomerDto) {
    const [customer] = await this.db.db
      .insert(customers)
      .values({ businessId: tenant.businessId, name: body.name.trim(), phone: body.phone })
      .returning();
    return customer;
  }

  @Patch(':id')
  async update(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCustomerDto,
  ) {
    if (Object.keys(body).length === 0) {
      throw new BadRequestException('At least one customer field must be provided');
    }

    const updates: Partial<typeof customers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const [customer] = await this.db.db
      .update(customers)
      .set(updates)
      .where(and(eq(customers.id, id), eq(customers.businessId, tenant.businessId)))
      .returning();
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  // Historical sales and receivables keep their customer reference intact.
  // DELETE is therefore a reversible archive, not a physical row deletion.
  @Delete(':id')
  async archive(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [customer] = await this.db.db
      .update(customers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.businessId, tenant.businessId)))
      .returning({ id: customers.id });
    if (!customer) throw new NotFoundException('Customer not found');
    return { success: true, archived: true, id: customer.id };
  }
}

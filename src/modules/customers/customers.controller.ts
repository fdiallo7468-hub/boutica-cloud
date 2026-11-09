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
import { and, count, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { customers } from '../../infrastructure/database/schema';
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
  ) {
    const filters = [eq(customers.businessId, tenant.businessId)];
    if (includeArchived !== 'true') filters.push(eq(customers.isActive, true));

    const [data, countResult] = await Promise.all([
      this.db.db.select().from(customers).where(and(...filters)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(customers).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
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

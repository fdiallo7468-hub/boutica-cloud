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
import { suppliers } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@ApiTags('suppliers')
@Controller('api/v1/suppliers')
export class SuppliersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(
    @CurrentTenant() tenant: Tenant,
    @Query() query: PaginationQueryDto,
    @Query('includeArchived') includeArchived?: string,
  ) {
    const filters = [eq(suppliers.businessId, tenant.businessId)];
    if (includeArchived !== 'true') filters.push(eq(suppliers.isActive, true));

    const [data, countResult] = await Promise.all([
      this.db.db.select().from(suppliers).where(and(...filters)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(suppliers).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [supplier] = await this.db.db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, id), eq(suppliers.businessId, tenant.businessId)));
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateSupplierDto) {
    const [supplier] = await this.db.db
      .insert(suppliers)
      .values({ businessId: tenant.businessId, name: body.name.trim(), phone: body.phone })
      .returning();
    return supplier;
  }

  @Patch(':id')
  async update(
    @CurrentTenant() tenant: Tenant,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateSupplierDto,
  ) {
    if (Object.keys(body).length === 0) {
      throw new BadRequestException('At least one supplier field must be provided');
    }

    const updates: Partial<typeof suppliers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.isActive !== undefined) updates.isActive = body.isActive;

    const [supplier] = await this.db.db
      .update(suppliers)
      .set(updates)
      .where(and(eq(suppliers.id, id), eq(suppliers.businessId, tenant.businessId)))
      .returning();
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  // Historical purchases keep their supplier reference intact.
  // DELETE is therefore a reversible archive, not a physical row deletion.
  @Delete(':id')
  async archive(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [supplier] = await this.db.db
      .update(suppliers)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(suppliers.id, id), eq(suppliers.businessId, tenant.businessId)))
      .returning({ id: suppliers.id });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return { success: true, archived: true, id: supplier.id };
  }
}

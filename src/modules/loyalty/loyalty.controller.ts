import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { customers, loyaltyConfigurations, loyaltyLedger } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { UpdateLoyaltyConfigDto } from './dto/update-loyalty-config.dto';

@Controller('api/v1/loyalty')
export class LoyaltyController {
  constructor(private readonly db: DatabaseService) {}

  @RequirePermissions(PERMISSIONS.CRM_READ)
  @Get('configuration')
  async getConfiguration(@CurrentTenant() tenant: Tenant) {
    const [config] = await this.db.db.select().from(loyaltyConfigurations)
      .where(eq(loyaltyConfigurations.businessId, tenant.businessId));
    return config ?? {
      businessId: tenant.businessId, enabled: false, earnPointsPer1000: 1,
      pointValue: '1.0000', minimumRedemptionPoints: 100, expiryDays: null,
    };
  }

  @RequirePermissions(PERMISSIONS.CRM_MANAGE)
  @Put('configuration')
  async updateConfiguration(
    @CurrentTenant() tenant: Tenant,
    @Body() body: UpdateLoyaltyConfigDto,
  ) {
    if (body.earnPointsPer1000 !== undefined && (!Number.isInteger(body.earnPointsPer1000) || body.earnPointsPer1000 < 0)) {
      throw new BadRequestException('earnPointsPer1000 must be a non-negative integer');
    }
    if (body.pointValue !== undefined && (!Number.isFinite(body.pointValue) || body.pointValue <= 0)) {
      throw new BadRequestException('pointValue must be greater than zero');
    }
    if (body.minimumRedemptionPoints !== undefined && (!Number.isInteger(body.minimumRedemptionPoints) || body.minimumRedemptionPoints < 0)) {
      throw new BadRequestException('minimumRedemptionPoints must be a non-negative integer');
    }
    if (body.expiryDays !== undefined && body.expiryDays !== null && (!Number.isInteger(body.expiryDays) || body.expiryDays <= 0)) {
      throw new BadRequestException('expiryDays must be null or a positive integer');
    }
    const [config] = await this.db.db.insert(loyaltyConfigurations).values({
      businessId: tenant.businessId,
      enabled: body.enabled ?? false,
      earnPointsPer1000: body.earnPointsPer1000 ?? 1,
      pointValue: String(body.pointValue ?? 1),
      minimumRedemptionPoints: body.minimumRedemptionPoints ?? 100,
      expiryDays: body.expiryDays ?? null,
    }).onConflictDoUpdate({
      target: loyaltyConfigurations.businessId,
      set: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.earnPointsPer1000 !== undefined ? { earnPointsPer1000: body.earnPointsPer1000 } : {}),
        ...(body.pointValue !== undefined ? { pointValue: String(body.pointValue) } : {}),
        ...(body.minimumRedemptionPoints !== undefined ? { minimumRedemptionPoints: body.minimumRedemptionPoints } : {}),
        ...(body.expiryDays !== undefined ? { expiryDays: body.expiryDays } : {}),
        updatedAt: new Date(),
      },
    }).returning();
    return config;
  }

  @RequirePermissions(PERMISSIONS.CRM_READ)
  @Get('customers/:customerId')
  async customerBalance(@CurrentTenant() tenant: Tenant, @Param('customerId', ParseUUIDPipe) customerId: string) {
    const [customer] = await this.db.db.select({ id: customers.id }).from(customers).where(and(
      eq(customers.id, customerId), eq(customers.businessId, tenant.businessId),
    ));
    if (!customer) throw new NotFoundException('Customer not found');
    const [balance] = await this.db.db.select({
      pointsBalance: sql<number>`coalesce(sum(${loyaltyLedger.pointsDelta}), 0)::int`,
    }).from(loyaltyLedger).where(and(
      eq(loyaltyLedger.businessId, tenant.businessId), eq(loyaltyLedger.customerId, customerId),
    ));
    const ledger = await this.db.db.select().from(loyaltyLedger).where(and(
      eq(loyaltyLedger.businessId, tenant.businessId), eq(loyaltyLedger.customerId, customerId),
    )).orderBy(desc(loyaltyLedger.createdAt)).limit(50);
    return { customerId, pointsBalance: Math.max(0, balance?.pointsBalance ?? 0), ledger };
  }
}

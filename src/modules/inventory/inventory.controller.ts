import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import { BadRequestException, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { AuditEventsService } from '../../infrastructure/database/audit-events.service';
import { businessLocations, inventoryBalances, stock, stockMovements, variants } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { InitializeOpeningValuationDto } from './dto/initialize-opening-valuation.dto';
import { InventoryValuationService } from './inventory-valuation.service';
import { AccountingOperationalPostingService } from '../accounting/accounting-operational-posting.service';

@ApiTags('inventory')
@Controller('api/v1/inventory')
export class InventoryController {
  constructor(
    private readonly db: DatabaseService,
    private readonly auditEvents: AuditEventsService = new AuditEventsService(),
    private readonly valuationService: InventoryValuationService = new InventoryValuationService(),
    private readonly accountingPosting: AccountingOperationalPostingService,
  ) {}

  @RequirePermissions(PERMISSIONS.INVENTORY_READ)
  @Get(':variantId')
  async get(@CurrentTenant() tenant: Tenant, @Param('variantId', ParseUUIDPipe) variantId: string) {
    // FIX (P0-1): the previous implementation looked up stock by variantId
    // alone, with no ownership check at all — any authenticated caller
    // could read (and, on the old adjust endpoint, overwrite) another
    // business's stock just by guessing/enumerating a variant UUID.
    const [variant] = await this.db.db
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.id, variantId), eq(variants.businessId, tenant.businessId)));
    if (!variant) throw new NotFoundException('Variant not found');

    const [row] = await this.db.db.select().from(stock).where(eq(stock.variantId, variantId));
    return row ?? { variantId, businessId: tenant.businessId, quantity: 0 };
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post(':variantId/valuation/opening')
  async initializeOpeningValuation(
    @CurrentTenant() tenant: Tenant,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() body: InitializeOpeningValuationDto,
  ) {
    return this.db.db.transaction(async (tx) => {
      const [variant] = await tx.select({ id: variants.id }).from(variants).where(and(
        eq(variants.id, variantId), eq(variants.businessId, tenant.businessId),
      ));
      if (!variant) throw new NotFoundException('Variant not found');
      const valuation = await this.valuationService.initializeOpening(
        tx, tenant.businessId, variantId, body.quantity, body.unitCost,
      );
      await this.auditEvents.appendInTransaction(tx, {
        businessId: tenant.businessId,
        actorUserId: tenant.userId,
        action: 'inventory.cump_opening_initialized',
        resourceType: 'variant',
        resourceId: variantId,
        metadata: { quantity: body.quantity, unitCost: body.unitCost, totalValue: valuation.totalValue },
      });
      return valuation;
    });
  }

  @RequirePermissions(PERMISSIONS.INVENTORY_MANAGE)
  @Post(':variantId/adjust')
  async adjust(@CurrentTenant() tenant: Tenant, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() body: AdjustStockDto) {
    return this.db.db.transaction(async (tx) => {
      const [location] = await tx.select({ id: businessLocations.id }).from(businessLocations).where(and(
        eq(businessLocations.businessId, tenant.businessId),
        eq(businessLocations.isDefault, true),
        eq(businessLocations.isActive, true),
      ));
      if (!location) throw new NotFoundException('No active default business location is configured');

      const [variant] = await tx
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.id, variantId), eq(variants.businessId, tenant.businessId)));
      if (!variant) throw new NotFoundException('Variant not found');

      const [current] = await tx
        .select()
        .from(stock)
        .where(eq(stock.variantId, variantId))
        .for('update');
      const previousQuantity = current?.quantity ?? 0;
      const delta = body.quantity - previousQuantity;
      let adjustmentValue: string | null = null;
      if (delta > 0) {
        if (body.unitCost === undefined) {
          throw new BadRequestException('unitCost is required for a positive stock adjustment under CUMP');
        }
        await this.valuationService.receive(tx, tenant.businessId, variantId, delta, body.unitCost);
        adjustmentValue = this.valuationService.extendedValue(body.unitCost, delta);
      } else if (delta < 0) {
        const averageUnitCost = await this.valuationService.adjustDown(tx, tenant.businessId, variantId, Math.abs(delta));
        adjustmentValue = this.valuationService.extendedValue(averageUnitCost, Math.abs(delta));
      }

      const [updated] = await tx
        .insert(stock)
        .values({ variantId, businessId: tenant.businessId, quantity: body.quantity })
        .onConflictDoUpdate({ target: stock.variantId, set: { quantity: body.quantity, updatedAt: new Date() } })
        .returning();

      await tx.insert(inventoryBalances)
        .values({ businessId: tenant.businessId, locationId: location.id, variantId, quantity: body.quantity })
        .onConflictDoUpdate({
          target: [inventoryBalances.businessId, inventoryBalances.locationId, inventoryBalances.variantId],
          set: { quantity: body.quantity, updatedAt: new Date() },
        });

      // FIX (P2-2): manual adjustments used to bypass stock_movements
      // entirely, silently breaking the audit trail the table exists for.
      if (delta !== 0) {
        const [movement] = await tx.insert(stockMovements).values({
          businessId: tenant.businessId,
          locationId: location.id,
          variantId,
          type: 'ADJUSTMENT',
          quantity: delta,
          note: body.note,
        }).returning();
        if (!movement || adjustmentValue === null) throw new ConflictException('Could not persist the valued stock adjustment');
        const accounting = await this.accountingPosting.postStockAdjustment(tx, tenant, movement, adjustmentValue);
        await this.auditEvents.appendInTransaction(tx, {
          businessId: tenant.businessId,
          actorUserId: tenant.userId,
          locationId: location.id,
          action: 'stock.adjusted',
          resourceType: 'variant',
          resourceId: variantId,
          metadata: { previousQuantity, newQuantity: body.quantity, delta, adjustmentValue, accountingStatus: accounting.status },
        });
      }

      return updated;
    });
  }
}

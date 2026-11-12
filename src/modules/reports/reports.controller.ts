import { PERMISSIONS } from '../auth/permissions/permission-catalog';
import { RequirePermissions } from '../auth/permissions/require-permissions.decorator';
import { BadRequestException, Controller, Get, Header, NotFoundException, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DatabaseService } from '../../infrastructure/database/database';
import { businessLocations, expenses, inventoryBalances, inventoryValuations, products, receivables, saleItems, sales, stock, variants } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('api/v1/reports')
export class ReportsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly reportsService: ReportsService,
  ) {}

  @ApiOperation({ summary: 'Indicateurs agrégés du tableau de bord (Chiffre d\'affaires, bénéfice, top produits)' })
  @RequirePermissions(PERMISSIONS.REPORTS_READ)
  @Get('dashboard')
  async dashboard(@CurrentTenant() tenant: Tenant, @Query() query: DashboardQueryDto) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('Invalid reporting date range');
    }
    const businessId = tenant.businessId;
    if (query.locationId) {
      const [location] = await this.db.db.select({ id: businessLocations.id }).from(businessLocations).where(and(
        eq(businessLocations.id, query.locationId),
        eq(businessLocations.businessId, businessId),
        eq(businessLocations.isActive, true),
      ));
      if (!location) throw new NotFoundException('Location not found');
    }
    const duration = Math.max(to.getTime() - from.getTime(), 1);
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - duration);

    const completedSalesInRange = and(
      eq(sales.businessId, businessId),
      eq(sales.status, 'COMPLETED'),
      gte(sales.createdAt, from),
      lte(sales.createdAt, to),
      ...(query.locationId ? [eq(sales.locationId, query.locationId)] : []),
    );
    const stockValueQuery = query.locationId
      ? this.db.db.select({
          stockValue: sql<string>`coalesce(sum(${inventoryBalances.quantity} * ${inventoryValuations.averageUnitCost}), 0)::text`,
          unvaluedStockQuantity: sql<number>`coalesce(sum(case when ${inventoryValuations.variantId} is null then ${inventoryBalances.quantity} else 0 end), 0)::int`,
        })
          .from(inventoryBalances)
          .innerJoin(variants, and(eq(inventoryBalances.variantId, variants.id), eq(inventoryBalances.businessId, variants.businessId)))
          .leftJoin(inventoryValuations, and(eq(inventoryValuations.businessId, inventoryBalances.businessId), eq(inventoryValuations.variantId, inventoryBalances.variantId)))
          .where(and(eq(inventoryBalances.businessId, businessId), eq(inventoryBalances.locationId, query.locationId)))
      : this.db.db.select({
          stockValue: sql<string>`coalesce(sum(${stock.quantity} * ${inventoryValuations.averageUnitCost}), 0)::text`,
          unvaluedStockQuantity: sql<number>`coalesce(sum(case when ${inventoryValuations.variantId} is null then ${stock.quantity} else 0 end), 0)::int`,
        })
          .from(stock)
          .innerJoin(variants, and(eq(stock.variantId, variants.id), eq(stock.businessId, variants.businessId)))
          .leftJoin(inventoryValuations, and(eq(inventoryValuations.businessId, stock.businessId), eq(inventoryValuations.variantId, stock.variantId)))
          .where(eq(stock.businessId, businessId));
    const lowStockQuery = query.locationId
      ? this.db.db.select({ variantId: inventoryBalances.variantId, quantity: inventoryBalances.quantity, variantName: variants.name, sku: variants.sku })
          .from(inventoryBalances).innerJoin(variants, eq(inventoryBalances.variantId, variants.id))
          .where(and(eq(inventoryBalances.businessId, businessId), eq(inventoryBalances.locationId, query.locationId), lte(inventoryBalances.quantity, query.lowStockThreshold)))
          .orderBy(inventoryBalances.quantity)
      : this.db.db.select({ variantId: stock.variantId, quantity: stock.quantity, variantName: variants.name, sku: variants.sku })
          .from(stock).innerJoin(variants, eq(stock.variantId, variants.id))
          .where(and(eq(stock.businessId, businessId), lte(stock.quantity, query.lowStockThreshold))).orderBy(stock.quantity);
    // Keep the date_trunc unit as a SQL literal from this allowlisted union.
    // A bound parameter is emitted independently in SELECT/GROUP BY/ORDER BY;
    // PostgreSQL then treats those placeholders as different expressions.
    const granularity = query.granularity ?? 'day';
    const bucket = granularity === 'week'
      ? sql<Date>`date_trunc('week', ${sales.createdAt})`
      : granularity === 'month'
        ? sql<Date>`date_trunc('month', ${sales.createdAt})`
        : sql<Date>`date_trunc('day', ${sales.createdAt})`;

    const [
      revenueRows,
      expensesRows,
      grossMarginRows,
      discountRows,
      stockValueRows,
      recentSales,
      topProducts,
      lowStock,
      receivablesRows,
      salesKpis,
      previousRevenueRows,
      timeSeriesRows,
    ] = await Promise.all([
      this.db.db
        .select({ revenue: sql<string>`coalesce(sum(${sales.total}), 0)` })
        .from(sales)
        .where(completedSalesInRange),
      this.db.db
        .select({ expensesTotal: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
        .from(expenses)
        .where(and(eq(expenses.businessId, businessId), gte(expenses.createdAt, from), lte(expenses.createdAt, to), ...(query.locationId ? [eq(expenses.locationId, query.locationId)] : []))),
      this.db.db
        .select({
          grossMargin: sql<string>`coalesce(sum(case when ${saleItems.costAtSale} is null then 0 else (${saleItems.unitPrice} - ${saleItems.costAtSale}) * ${saleItems.quantity} end), 0)`,
          unvaluedSaleItems: sql<number>`count(*) filter (where ${saleItems.costAtSale} is null)::int`,
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .innerJoin(variants, eq(saleItems.variantId, variants.id))
        .where(completedSalesInRange),
      this.db.db.select({ discountTotal: sql<string>`coalesce(sum(${sales.discount}), 0)::text` }).from(sales).where(completedSalesInRange),
      stockValueQuery,
      this.db.db
        .select({ id: sales.id, total: sales.total, customerId: sales.customerId, createdAt: sales.createdAt })
        .from(sales)
        .where(and(eq(sales.businessId, businessId), eq(sales.status, 'COMPLETED'), ...(query.locationId ? [eq(sales.locationId, query.locationId)] : [])))
        .orderBy(desc(sales.createdAt))
        .limit(10),
      this.db.db
        .select({
          variantId: variants.id,
          productName: products.name,
          variantName: variants.name,
          sku: variants.sku,
          quantitySold: sql<number>`sum(${saleItems.quantity})`.mapWith(Number),
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .innerJoin(variants, eq(saleItems.variantId, variants.id))
        .innerJoin(products, eq(variants.productId, products.id))
        .where(completedSalesInRange)
        .groupBy(variants.id, products.name, variants.name, variants.sku)
        .orderBy(desc(sql`sum(${saleItems.quantity})`))
        .limit(5),
      lowStockQuery,
      this.db.db
        .select({
          totalOutstanding: sql<string>`coalesce(sum(${receivables.remainingBalance}), '0.00')`,
          overdueAmount: sql<string>`coalesce(sum(case when ${receivables.dueDate} < now() and ${receivables.remainingBalance} > 0 then ${receivables.remainingBalance} else 0 end), '0.00')`,
          count: sql<number>`count(*)::int`,
        })
        .from(receivables)
        .where(and(eq(receivables.businessId, businessId), ne(receivables.status, 'PAID'), ne(receivables.status, 'CANCELLED'), ...(query.locationId ? [eq(receivables.locationId, query.locationId)] : []))),
      this.db.db.select({ completedSalesCount: count(), averageBasket: sql<string>`coalesce(round(avg(${sales.total}), 2), 0)::text` })
        .from(sales).where(completedSalesInRange),
      this.db.db.select({ revenue: sql<string>`coalesce(sum(${sales.total}), 0)::text` })
        .from(sales).where(and(eq(sales.businessId, businessId), eq(sales.status, 'COMPLETED'), gte(sales.createdAt, previousFrom), lte(sales.createdAt, previousTo), ...(query.locationId ? [eq(sales.locationId, query.locationId)] : []))),
      this.db.db.select({ bucket, revenue: sql<string>`coalesce(sum(${sales.total}), 0)::text`, completedSalesCount: count(), averageBasket: sql<string>`coalesce(round(avg(${sales.total}), 2), 0)::text` })
        .from(sales).where(completedSalesInRange).groupBy(bucket).orderBy(bucket),
    ]);

    const revenue = revenueRows[0]?.revenue ?? '0.00';
    const expensesTotal = expensesRows[0]?.expensesTotal ?? '0.00';
    const grossMargin = (Number(grossMarginRows[0]?.grossMargin ?? 0) - Number(discountRows[0]?.discountTotal ?? 0)).toFixed(2);
    const stockValue = stockValueRows[0]?.stockValue ?? '0.00';
    const unvaluedStockQuantity = stockValueRows[0]?.unvaluedStockQuantity ?? 0;
    const unvaluedSaleItems = grossMarginRows[0]?.unvaluedSaleItems ?? 0;
    const receivablesSummary = receivablesRows[0] ?? { totalOutstanding: '0.00', overdueAmount: '0.00', count: 0 };

    return {
      period: { from: from.toISOString(), to: to.toISOString(), locationId: query.locationId ?? null, granularity: query.granularity ?? 'day' },
      revenue,
      completedSalesCount: salesKpis[0]?.completedSalesCount ?? 0,
      averageBasket: salesKpis[0]?.averageBasket ?? '0.00',
      previousPeriod: { from: previousFrom.toISOString(), to: previousTo.toISOString(), revenue: previousRevenueRows[0]?.revenue ?? '0.00' },
      expensesTotal,
      discountsTotal: discountRows[0]?.discountTotal ?? '0.00',
      grossMarginEstimate: grossMargin,
      estimatedProfit: ((toMinorUnits(grossMargin) - toMinorUnits(expensesTotal)) / 100).toFixed(2),
      estimatedProfitIsEstimate: true,
      stockValue,
      unvaluedStockQuantity,
      unvaluedSaleItems,
      receivables: {
        totalOutstanding: receivablesSummary.totalOutstanding,
        overdueAmount: receivablesSummary.overdueAmount,
        activeCount: receivablesSummary.count,
      },
      recentSales,
      topProducts,
      lowStockAlerts: lowStock,
      timeSeries: timeSeriesRows,
    };
  }

  @ApiOperation({ summary: 'Exporter les ventes de la période au format Excel (.xlsx)' })
  @RequirePermissions(PERMISSIONS.REPORTS_EXPORT)
  @Get('sales/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportSalesExcel(
    @CurrentTenant() tenant: Tenant,
    @Query() query: DashboardQueryDto,
    @Res() res: Response,
  ) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    this.validateExportPeriod(from, to);
    await this.validateExportLocation(tenant.businessId, query.locationId);
    const buffer = await this.reportsService.exportSalesExcel(tenant.businessId, from, to, query.locationId);

    res.setHeader('Content-Disposition', `attachment; filename="ventes-${from.toISOString().slice(0, 10)}.xlsx"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Exporter l\'inventaire et les stocks au format Excel (.xlsx)' })
  @RequirePermissions(PERMISSIONS.REPORTS_EXPORT)
  @Get('inventory/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportInventoryExcel(
    @CurrentTenant() tenant: Tenant,
    @Query('locationId') locationId: string | undefined,
    @Res() res: Response,
  ) {
    await this.validateExportLocation(tenant.businessId, locationId);
    const buffer = await this.reportsService.exportInventoryExcel(tenant.businessId, locationId);
    res.setHeader('Content-Disposition', `attachment; filename="inventaire-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Générer et télécharger le rapport des ventes en PDF professionnel' })
  @RequirePermissions(PERMISSIONS.REPORTS_EXPORT)
  @Get('sales/pdf')
  async exportSalesPdf(
    @CurrentTenant() tenant: Tenant,
    @Query() query: DashboardQueryDto,
    @Res() res: Response,
  ) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    this.validateExportPeriod(from, to);
    await this.validateExportLocation(tenant.businessId, query.locationId);
    const buffer = await this.reportsService.exportSalesPdf(tenant.businessId, from, to, query.locationId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${from.toISOString().slice(0, 10)}.pdf"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Générer et télécharger l\'état des stocks en PDF professionnel' })
  @RequirePermissions(PERMISSIONS.REPORTS_EXPORT)
  @Get('inventory/pdf')
  async exportInventoryPdf(
    @CurrentTenant() tenant: Tenant,
    @Query('locationId') locationId: string | undefined,
    @Res() res: Response,
  ) {
    await this.validateExportLocation(tenant.businessId, locationId);
    const buffer = await this.reportsService.exportInventoryPdf(tenant.businessId, locationId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etat-stocks-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.end(buffer);
  }

  private validateExportPeriod(from: Date, to: Date) {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw new BadRequestException('Invalid reporting date range');
    }
  }

  private async validateExportLocation(businessId: string, locationId?: string) {
    if (!locationId) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(locationId)) {
      throw new BadRequestException('Invalid location ID');
    }
    const [location] = await this.db.db.select({ id: businessLocations.id }).from(businessLocations).where(and(
      eq(businessLocations.id, locationId), eq(businessLocations.businessId, businessId), eq(businessLocations.isActive, true),
    ));
    if (!location) throw new NotFoundException('Location not found');
  }
}

function toMinorUnits(decimal: string, decimals = 2): number {
  return Math.round(Number(decimal) * 10 ** decimals);
}

import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Response } from 'express';
import { DatabaseService } from '../../infrastructure/database/database';
import { expenses, products, saleItems, sales, stock, variants } from '../../infrastructure/database/schema';
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
  @Get('dashboard')
  async dashboard(@CurrentTenant() tenant: Tenant, @Query() query: DashboardQueryDto) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    const businessId = tenant.businessId;

    const completedSalesInRange = and(
      eq(sales.businessId, businessId),
      eq(sales.status, 'COMPLETED'),
      gte(sales.createdAt, from),
      lte(sales.createdAt, to),
    );

    const [
      revenueRows,
      expensesRows,
      grossMarginRows,
      stockValueRows,
      recentSales,
      topProducts,
      lowStock,
    ] = await Promise.all([
      this.db.db
        .select({ revenue: sql<string>`coalesce(sum(${sales.total}), 0)` })
        .from(sales)
        .where(completedSalesInRange),
      this.db.db
        .select({ expensesTotal: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
        .from(expenses)
        .where(and(eq(expenses.businessId, businessId), gte(expenses.createdAt, from), lte(expenses.createdAt, to))),
      this.db.db
        .select({
          grossMargin: sql<string>`coalesce(sum((${saleItems.unitPrice} - coalesce(${saleItems.costAtSale}, ${variants.purchasePrice})) * ${saleItems.quantity}), 0)`,
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .innerJoin(variants, eq(saleItems.variantId, variants.id))
        .where(completedSalesInRange),
      this.db.db
        .select({ stockValue: sql<string>`coalesce(sum(${stock.quantity} * ${variants.purchasePrice}), 0)` })
        .from(stock)
        .innerJoin(variants, eq(stock.variantId, variants.id))
        .where(eq(stock.businessId, businessId)),
      this.db.db
        .select({ id: sales.id, total: sales.total, customerId: sales.customerId, createdAt: sales.createdAt })
        .from(sales)
        .where(and(eq(sales.businessId, businessId), eq(sales.status, 'COMPLETED')))
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
      this.db.db
        .select({ variantId: stock.variantId, quantity: stock.quantity, variantName: variants.name, sku: variants.sku })
        .from(stock)
        .innerJoin(variants, eq(stock.variantId, variants.id))
        .where(and(eq(stock.businessId, businessId), lte(stock.quantity, query.lowStockThreshold)))
        .orderBy(stock.quantity),
    ]);

    const revenue = revenueRows[0]?.revenue ?? '0.00';
    const expensesTotal = expensesRows[0]?.expensesTotal ?? '0.00';
    const grossMargin = grossMarginRows[0]?.grossMargin ?? '0.00';
    const stockValue = stockValueRows[0]?.stockValue ?? '0.00';

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      revenue,
      expensesTotal,
      estimatedProfit: ((toMinorUnits(grossMargin) - toMinorUnits(expensesTotal)) / 100).toFixed(2),
      stockValue,
      receivables: null,
      recentSales,
      topProducts,
      lowStockAlerts: lowStock,
    };
  }

  @ApiOperation({ summary: 'Exporter les ventes de la période au format Excel (.xlsx)' })
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
    const buffer = await this.reportsService.exportSalesExcel(tenant.businessId, from, to);

    res.setHeader('Content-Disposition', `attachment; filename="ventes-${from.toISOString().slice(0, 10)}.xlsx"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Exporter l\'inventaire et les stocks au format Excel (.xlsx)' })
  @Get('inventory/excel')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportInventoryExcel(
    @CurrentTenant() tenant: Tenant,
    @Res() res: Response,
  ) {
    const buffer = await this.reportsService.exportInventoryExcel(tenant.businessId);
    res.setHeader('Content-Disposition', `attachment; filename="inventaire-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Générer et télécharger le rapport des ventes en PDF professionnel' })
  @Get('sales/pdf')
  async exportSalesPdf(
    @CurrentTenant() tenant: Tenant,
    @Query() query: DashboardQueryDto,
    @Res() res: Response,
  ) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    const buffer = await this.reportsService.exportSalesPdf(tenant.businessId, from, to);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${from.toISOString().slice(0, 10)}.pdf"`);
    res.end(buffer);
  }

  @ApiOperation({ summary: 'Générer et télécharger l\'état des stocks en PDF professionnel' })
  @Get('inventory/pdf')
  async exportInventoryPdf(
    @CurrentTenant() tenant: Tenant,
    @Res() res: Response,
  ) {
    const buffer = await this.reportsService.exportInventoryPdf(tenant.businessId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etat-stocks-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.end(buffer);
  }
}

function toMinorUnits(decimal: string, decimals = 2): number {
  return Math.round(Number(decimal) * 10 ** decimals);
}

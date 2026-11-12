import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import puppeteer, { type Browser, type Page, type LaunchOptions } from 'puppeteer';
import { DatabaseService } from '../../infrastructure/database/database';
import {
  inventoryBalances,
  inventoryValuations,
  products,
  saleItems,
  sales,
  stock,
  variants,
} from '../../infrastructure/database/schema';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(private readonly db: DatabaseService) {}

  private escapeHtml(text: string | number | null | undefined): string {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- EXCEL EXPORTS ---

  async exportSalesExcel(businessId: string, from: Date, to: Date, locationId?: string): Promise<Buffer> {
    const rows = await this.db.db
      .select({
        saleId: sales.id,
        createdAt: sales.createdAt,
        total: sales.total,
        saleTotal: sales.total,
        status: sales.status,
        productName: products.name,
        variantName: variants.name,
        sku: variants.sku,
        quantity: saleItems.quantity,
        unitPrice: saleItems.unitPrice,
      })
      .from(saleItems)
      .innerJoin(sales, eq(saleItems.saleId, sales.id))
      .innerJoin(variants, eq(saleItems.variantId, variants.id))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(
        and(
          eq(sales.businessId, businessId),
          eq(sales.status, 'COMPLETED'),
          gte(sales.createdAt, from),
          lte(sales.createdAt, to),
          ...(locationId ? [eq(sales.locationId, locationId)] : []),
        ),
      )
      .orderBy(desc(sales.createdAt));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Boutica Cloud';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Ventes', {
      views: [{ showGridLines: true }],
    });

    sheet.columns = [
      { header: 'ID Vente', key: 'saleId', width: 25 },
      { header: 'Date', key: 'date', width: 20 },
      { header: 'Produit', key: 'product', width: 25 },
      { header: 'Variante', key: 'variant', width: 20 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Quantité', key: 'qty', width: 12 },
      { header: 'Prix Unitaire', key: 'unitPrice', width: 15 },
      { header: 'Total Ligne', key: 'lineTotal', width: 15 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F46E5' },
    };

    const totalBySale = new Map<string, number>();
    for (const r of rows) {
      const lineTotal = Number(r.unitPrice) * r.quantity;
      totalBySale.set(r.saleId, Number(r.saleTotal));
      sheet.addRow({
        saleId: r.saleId,
        date: r.createdAt ? new Date(r.createdAt).toLocaleString('fr-FR') : '',
        product: r.productName,
        variant: r.variantName,
        sku: r.sku,
        qty: r.quantity,
        unitPrice: Number(r.unitPrice),
        lineTotal,
      });
    }

    const totalGlobal = [...totalBySale.values()].reduce((sum, value) => sum + value, 0);
    const totalRow = sheet.addRow({
      product: 'TOTAL VENTES (après remises)',
      lineTotal: totalGlobal,
    });
    totalRow.font = { bold: true };

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  async exportInventoryExcel(businessId: string, locationId?: string): Promise<Buffer> {
    const items = locationId ? await this.db.db
      .select({ productId: products.id, productName: products.name, variantId: variants.id, variantName: variants.name, sku: variants.sku, quantity: inventoryBalances.quantity, cost: inventoryValuations.averageUnitCost, price: variants.sellingPrice })
      .from(inventoryBalances).innerJoin(variants, and(eq(inventoryBalances.variantId, variants.id), eq(inventoryBalances.businessId, variants.businessId)))
      .leftJoin(inventoryValuations, and(eq(inventoryValuations.businessId, inventoryBalances.businessId), eq(inventoryValuations.variantId, inventoryBalances.variantId)))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(and(eq(inventoryBalances.businessId, businessId), eq(inventoryBalances.locationId, locationId)))
      .orderBy(products.name, variants.name) : await this.db.db
      .select({
        productId: products.id,
        productName: products.name,
        variantId: variants.id,
        variantName: variants.name,
        sku: variants.sku,
        quantity: stock.quantity,
        cost: inventoryValuations.averageUnitCost,
        price: variants.sellingPrice,
      })
      .from(stock)
      .innerJoin(variants, and(eq(stock.variantId, variants.id), eq(stock.businessId, variants.businessId)))
      .leftJoin(inventoryValuations, and(eq(inventoryValuations.businessId, stock.businessId), eq(inventoryValuations.variantId, stock.variantId)))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(eq(stock.businessId, businessId))
      .orderBy(products.name, variants.name);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Boutica Cloud';
    const sheet = workbook.addWorksheet('Inventaire');

    sheet.columns = [
      { header: 'Produit', key: 'product', width: 25 },
      { header: 'Variante', key: 'variant', width: 20 },
      { header: 'SKU', key: 'sku', width: 15 },
      { header: 'Quantité en Stock', key: 'quantity', width: 18 },
      { header: 'Coût d\'Achat', key: 'cost', width: 15 },
      { header: 'Prix de Vente', key: 'price', width: 15 },
      { header: 'Valeur Stock (Coût)', key: 'stockValue', width: 20 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0D9488' },
    };

    let totalVal = 0;
    let unvaluedVariants = 0;
    for (const item of items) {
      const unitCost = item.cost === null ? null : Number(item.cost);
      const val = unitCost === null ? null : unitCost * item.quantity;
      if (val === null) unvaluedVariants += 1;
      else totalVal += val;
      sheet.addRow({
        product: item.productName,
        variant: item.variantName,
        sku: item.sku,
        quantity: item.quantity,
        cost: unitCost === null ? 'Non valorisé' : unitCost,
        price: Number(item.price),
        stockValue: val === null ? 'Non valorisé' : val,
      });
    }

    const totalRow = sheet.addRow({
      product: 'TOTAL VALEUR DU STOCK (CUMP VALORISÉ)',
      stockValue: totalVal,
    });
    totalRow.font = { bold: true };
    if (unvaluedVariants > 0) {
      const unvaluedRow = sheet.addRow({ product: 'VARIANTES NON VALORISÉES', stockValue: unvaluedVariants });
      unvaluedRow.font = { bold: true };
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  // --- PDF EXPORTS (Puppeteer) ---

  async exportSalesPdf(businessId: string, from: Date, to: Date, locationId?: string): Promise<Buffer> {
    const rows = await this.db.db
      .select({
        saleId: sales.id,
        createdAt: sales.createdAt,
        total: sales.total,
        status: sales.status,
      })
      .from(sales)
      .where(
        and(
          eq(sales.businessId, businessId),
          eq(sales.status, 'COMPLETED'),
          gte(sales.createdAt, from),
          lte(sales.createdAt, to),
          ...(locationId ? [eq(sales.locationId, locationId)] : []),
        ),
      )
      .orderBy(desc(sales.createdAt));

    const totalRevenue = rows.reduce((acc, r) => acc + Number(r.total), 0);

    const html = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 40px; color: #1e293b; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #4f46e5; padding-bottom: 15px; margin-bottom: 25px; }
          .logo { font-size: 24px; font-weight: 800; color: #4f46e5; }
          .subtitle { color: #64748b; font-size: 13px; }
          .badge { background: #e0e7ff; color: #4338ca; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
          th { background: #f8fafc; color: #475569; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e2e8f0; }
          td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; }
          .text-right { text-align: right; }
          .total-box { margin-top: 30px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: flex-end; gap: 30px; font-size: 14px; }
          .footer { margin-top: 40px; font-size: 11px; color: #94a3b8; text-align: center; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="logo">BOUTICA CLOUD</div>
            <div class="subtitle">Rapport officiel des ventes</div>
          </div>
          <div class="badge">Période : ${from.toLocaleDateString('fr-FR')} — ${to.toLocaleDateString('fr-FR')}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th>ID Vente</th>
              <th>Date & Heure</th>
              <th>Statut</th>
              <th class="text-right">Montant Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td><code>${this.escapeHtml(r.saleId.slice(0, 12))}...</code></td>
                <td>${r.createdAt ? new Date(r.createdAt).toLocaleString('fr-FR') : ''}</td>
                <td><span style="color: #16a34a; font-weight: 600;">${this.escapeHtml(r.status)}</span></td>
                <td class="text-right"><strong>${Number(r.total).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</strong></td>
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>

        <div class="total-box">
          <div>Nombre de transactions : <strong>${rows.length}</strong></div>
          <div>Chiffre d'Affaires Total : <strong style="color: #4f46e5; font-size: 16px;">${totalRevenue.toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</strong></div>
        </div>

        <div class="footer">
          Document généré automatiquement par Boutica Cloud le ${new Date().toLocaleString('fr-FR')}.
        </div>
      </body>
      </html>
    `;

    return this.renderHtmlToPdf(html);
  }

  async exportInventoryPdf(businessId: string, locationId?: string): Promise<Buffer> {
    const items = locationId ? await this.db.db
      .select({ productName: products.name, variantName: variants.name, sku: variants.sku, quantity: inventoryBalances.quantity, price: variants.sellingPrice })
      .from(inventoryBalances).innerJoin(variants, and(eq(inventoryBalances.variantId, variants.id), eq(inventoryBalances.businessId, variants.businessId)))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(and(eq(inventoryBalances.businessId, businessId), eq(inventoryBalances.locationId, locationId)))
      .orderBy(inventoryBalances.quantity) : await this.db.db
      .select({
        productName: products.name,
        variantName: variants.name,
        sku: variants.sku,
        quantity: stock.quantity,
        price: variants.sellingPrice,
      })
      .from(stock)
      .innerJoin(variants, eq(stock.variantId, variants.id))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(eq(stock.businessId, businessId))
      .orderBy(stock.quantity);

    const html = `
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 40px; color: #1e293b; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0d9488; padding-bottom: 15px; margin-bottom: 25px; }
          .logo { font-size: 24px; font-weight: 800; color: #0d9488; }
          .subtitle { color: #64748b; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
          th { background: #f8fafc; color: #475569; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e2e8f0; }
          td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; }
          .text-right { text-align: right; }
          .low-stock { color: #dc2626; font-weight: 700; }
          .ok-stock { color: #16a34a; font-weight: 600; }
          .footer { margin-top: 40px; font-size: 11px; color: #94a3b8; text-align: center; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="logo">BOUTICA CLOUD</div>
            <div class="subtitle">État des Stocks et Niveaux d'Inventaire</div>
          </div>
          <div>Date d'export : ${new Date().toLocaleDateString('fr-FR')}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Produit</th>
              <th>Variante</th>
              <th>SKU</th>
              <th class="text-right">Prix de Vente</th>
              <th class="text-right">Stock Disponible</th>
            </tr>
          </thead>
          <tbody>
            ${items
              .map(
                (item) => `
              <tr>
                <td><strong>${this.escapeHtml(item.productName)}</strong></td>
                <td>${this.escapeHtml(item.variantName)}</td>
                <td><code>${this.escapeHtml(item.sku)}</code></td>
                <td class="text-right">${Number(item.price).toLocaleString('fr-FR', { minimumFractionDigits: 2 })}</td>
                <td class="text-right ${item.quantity <= 5 ? 'low-stock' : 'ok-stock'}">
                  ${item.quantity} ${item.quantity <= 5 ? '⚠️' : ''}
                </td>
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>

        <div class="footer">
          Document généré par Boutica Cloud pour inventaire physique.
        </div>
      </body>
      </html>
    `;

    return this.renderHtmlToPdf(html);
  }

  private async renderHtmlToPdf(html: string): Promise<Buffer> {
    let browser: Browser | null = null;
    let page: Page | null = null;
    try {
      const launchOptions: LaunchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      browser = await puppeteer.launch(launchOptions);
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
      });
      return Buffer.from(pdfBuffer);
    } catch (err: any) {
      this.logger.error(`Erreur génération PDF Puppeteer: ${err?.message || err}`, err?.stack);
      throw new InternalServerErrorException(
        'Impossible de générer le document PDF pour le moment. Veuillez réessayer ultérieurement.',
        { cause: err },
      );
    } finally {
      if (page) {
        await page.close().catch((closeErr: any) => {
          this.logger.warn(`Erreur fermeture page Puppeteer: ${closeErr?.message || closeErr}`);
        });
      }
      if (browser) {
        await browser.close().catch((closeErr: any) => {
          this.logger.warn(`Erreur fermeture navigateur Puppeteer: ${closeErr?.message || closeErr}`);
        });
      }
    }
  }
}

import { InternalServerErrorException } from '@nestjs/common';
import puppeteer from 'puppeteer';
import { DatabaseService } from '../../infrastructure/database/database';
import { ReportsService } from './reports.service';

jest.mock('puppeteer', () => ({
  launch: jest.fn(),
}));

describe('ReportsService - Génération PDF', () => {
  let service: ReportsService;
  let mockDbService: any;
  let mockPage: any;
  let mockBrowser: any;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PUPPETEER_EXECUTABLE_PATH;

    mockPage = {
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock binary pdf data')),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockBrowser = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (puppeteer.launch as jest.Mock).mockResolvedValue(mockBrowser);

    mockDbService = {
      db: {
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([
                {
                  saleId: 'sale-123456789012',
                  createdAt: new Date('2026-03-15T10:00:00Z'),
                  total: '150.00',
                  status: 'COMPLETED',
                },
              ]),
            }),
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockResolvedValue([
                    {
                      productName: 'T-Shirt Blanc',
                      variantName: 'Taille M',
                      sku: 'TSH-WHT-M',
                      quantity: 12,
                      price: '25.00',
                    },
                  ]),
                }),
              }),
            }),
          }),
        }),
      },
    };

    service = new ReportsService(mockDbService as DatabaseService);
  });

  describe('exportSalesPdf', () => {
    it('génère un véritable buffer PDF et ferme les ressources', async () => {
      const from = new Date('2026-03-01');
      const to = new Date('2026-03-31');

      const result = await service.exportSalesPdf('biz-123', from, to);

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString('utf-8')).toContain('%PDF-1.4');

      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        }),
      );

      expect(mockBrowser.newPage).toHaveBeenCalled();
      expect(mockPage.setContent).toHaveBeenCalledWith(
        expect.stringContaining('BOUTICA CLOUD'),
        { waitUntil: 'domcontentloaded' },
      );
      expect(mockPage.pdf).toHaveBeenCalledWith({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' },
      });

      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    it('utilise PUPPETEER_EXECUTABLE_PATH si défini', async () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = '/usr/bin/google-chrome-stable';

      await service.exportSalesPdf('biz-123', new Date(), new Date());

      expect(puppeteer.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          executablePath: '/usr/bin/google-chrome-stable',
        }),
      );
    });
  });

  describe('exportInventoryPdf', () => {
    it('génère un rapport d inventaire PDF avec succès', async () => {
      const result = await service.exportInventoryPdf('biz-123');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString('utf-8')).toContain('%PDF-1.4');
      expect(mockPage.setContent).toHaveBeenCalledWith(
        expect.stringContaining("État des Stocks et Niveaux d'Inventaire"),
        { waitUntil: 'domcontentloaded' },
      );
      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('Gestion robuste des erreurs et absence de fallback HTML', () => {
    it('lève InternalServerErrorException lors de l échec du lancement du navigateur', async () => {
      const chromeNotFoundErr = new Error('Could not find Chrome (ver. 155.0.8059.79).');
      (puppeteer.launch as jest.Mock).mockRejectedValueOnce(chromeNotFoundErr);

      await expect(
        service.exportSalesPdf('biz-123', new Date(), new Date()),
      ).rejects.toThrow(InternalServerErrorException);

      try {
        await service.exportSalesPdf('biz-123', new Date(), new Date());
      } catch (err: any) {
        expect(err).toBeInstanceOf(InternalServerErrorException);
        expect(err.message).toBe(
          'Impossible de générer le document PDF pour le moment. Veuillez réessayer ultérieurement.',
        );
        expect(err.cause).toBe(chromeNotFoundErr);
        // Vérifie qu aucun fallback HTML n est renvoyé
        expect(err).not.toBeInstanceOf(Buffer);
      }
    });

    it('ferme le navigateur et la page si page.pdf() échoue, et propage l exception', async () => {
      const pdfRenderErr = new Error('Protocol error (Page.printToPDF): Printing failed');
      mockPage.pdf.mockRejectedValueOnce(pdfRenderErr);

      await expect(
        service.exportSalesPdf('biz-123', new Date(), new Date()),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });

    it('ferme les ressources si page.setContent() échoue', async () => {
      mockPage.setContent.mockRejectedValueOnce(new Error('DOM parsing error'));

      await expect(
        service.exportInventoryPdf('biz-123'),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockPage.close).toHaveBeenCalledTimes(1);
      expect(mockBrowser.close).toHaveBeenCalledTimes(1);
    });
  });
});

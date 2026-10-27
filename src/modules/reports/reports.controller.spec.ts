jest.mock('puppeteer', () => ({}));
jest.mock('../auth/current-tenant.decorator', () => ({
  CurrentTenant: () => () => {},
}));

import { InternalServerErrorException } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

describe('ReportsController - Endpoints PDF', () => {
  let controller: ReportsController;
  let mockReportsService: any;
  let mockDb: any;
  let mockResponse: any;

  const tenant = {
    userId: 'user-1',
    businessId: 'biz-1',
    role: 'OWNER' as const,
  };

  beforeEach(() => {
    mockReportsService = {
      exportSalesPdf: jest.fn(),
      exportInventoryPdf: jest.fn(),
    };
    mockDb = { db: {} };

    mockResponse = {
      setHeader: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    controller = new ReportsController(mockDb, mockReportsService as unknown as ReportsService);
  });

  describe('GET /sales/pdf', () => {
    it('définit les en-têtes PDF appropriés et transmet le buffer PDF', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 test sales pdf content');
      mockReportsService.exportSalesPdf.mockResolvedValue(pdfBuffer);

      await controller.exportSalesPdf(
        tenant,
        { from: '2026-03-01', to: '2026-03-31' } as any,
        mockResponse as Response,
      );

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="rapport-ventes-2026-03-01.pdf"',
      );
      expect(mockResponse.end).toHaveBeenCalledWith(pdfBuffer);
    });

    it('propage l exception en cas d échec sans émettre d en-tête ni de faux PDF', async () => {
      const error = new InternalServerErrorException('Erreur Puppeteer');
      mockReportsService.exportSalesPdf.mockRejectedValue(error);

      await expect(
        controller.exportSalesPdf(
          tenant,
          { from: '2026-03-01', to: '2026-03-31' } as any,
          mockResponse as Response,
        ),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockResponse.setHeader).not.toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockResponse.end).not.toHaveBeenCalled();
    });
  });

  describe('GET /inventory/pdf', () => {
    it('définit les en-têtes PDF appropriés et transmet le buffer PDF', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 test inventory pdf content');
      mockReportsService.exportInventoryPdf.mockResolvedValue(pdfBuffer);

      await controller.exportInventoryPdf(tenant, mockResponse as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringMatching(/^attachment; filename="etat-stocks-\d{4}-\d{2}-\d{2}\.pdf"$/),
      );
      expect(mockResponse.end).toHaveBeenCalledWith(pdfBuffer);
    });

    it('propage l exception en cas d échec sans envoyer de données corrompues', async () => {
      const error = new InternalServerErrorException('Erreur Puppeteer');
      mockReportsService.exportInventoryPdf.mockRejectedValue(error);

      await expect(
        controller.exportInventoryPdf(tenant, mockResponse as Response),
      ).rejects.toThrow(InternalServerErrorException);

      expect(mockResponse.setHeader).not.toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(mockResponse.end).not.toHaveBeenCalled();
    });
  });
});

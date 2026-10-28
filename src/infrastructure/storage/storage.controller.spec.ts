jest.mock('../../modules/auth/current-tenant.decorator', () => ({
  CurrentTenant: () => () => {},
}));

import { BadRequestException } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';
import { Tenant } from '../../modules/auth/tenant.type';

describe('StorageController', () => {
  let controller: StorageController;
  let mockStorageService: jest.Mocked<StorageService>;

  const tenant: Tenant = {
    userId: 'user-123',
    businessId: 'biz-123',
    role: 'OWNER',
  };

  beforeEach(() => {
    mockStorageService = {
      getPresignedUploadUrl: jest.fn(),
      uploadDirect: jest.fn(),
      getPresignedDownloadUrl: jest.fn(),
      getFile: jest.fn(),
      deleteFile: jest.fn(),
    } as any;

    controller = new StorageController(mockStorageService);
  });

  describe('uploadFile', () => {
    it('devrait rejeter un upload sans fichier', async () => {
      await expect(controller.uploadFile(tenant, undefined, 'products')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('devrait rejeter un upload avec un fichier vide', async () => {
      const emptyFile = {
        originalname: 'empty.png',
        buffer: Buffer.alloc(0),
        mimetype: 'image/png',
      } as Express.Multer.File;

      await expect(controller.uploadFile(tenant, emptyFile, 'products')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('devrait transmettre la clé attendue si fournie dans la query ou le body', async () => {
      const validFile = {
        originalname: 'test.png',
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimetype: 'image/png',
      } as Express.Multer.File;

      const expectedKey = 'businesses/biz-123/catalog/uuid-test.png';
      mockStorageService.uploadDirect.mockResolvedValue({
        key: expectedKey,
        url: 'https://boutica.cloud/api/v1/media/file?key=' + encodeURIComponent(expectedKey),
        downloadUrl: 'https://boutica.cloud/api/v1/media/file?key=' + encodeURIComponent(expectedKey),
        publicUrl: 'https://boutica.cloud/api/v1/media/file?key=' + encodeURIComponent(expectedKey),
        size: 8,
      });

      // Test avec queryKey
      await controller.uploadFile(tenant, validFile, undefined, 'catalog', undefined, expectedKey);
      expect(mockStorageService.uploadDirect).toHaveBeenCalledWith(
        'biz-123',
        'catalog',
        'test.png',
        validFile.buffer,
        'image/png',
        expectedKey,
      );

      // Test avec bodyKey
      await controller.uploadFile(tenant, validFile, 'invoices', undefined, expectedKey, undefined);
      expect(mockStorageService.uploadDirect).toHaveBeenCalledWith(
        'biz-123',
        'invoices',
        'test.png',
        validFile.buffer,
        'image/png',
        expectedKey,
      );
    });
  });

  describe('Validation des paramètres key', () => {
    it('devrait rejeter getDownloadUrl sans paramètre key', async () => {
      await expect(controller.getDownloadUrl(tenant, '')).rejects.toThrow(BadRequestException);
      await expect(controller.getDownloadUrl(tenant, '   ')).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter deleteFile sans paramètre key', async () => {
      await expect(controller.deleteFile(tenant, '')).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter getFile sans paramètre key', async () => {
      const res = { setHeader: jest.fn(), sendFile: jest.fn() } as any;
      await expect(controller.getFile(tenant, '', res)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPresignedUrl', () => {
    it('devrait déléguer au service de stockage avec les bons paramètres', async () => {
      mockStorageService.getPresignedUploadUrl.mockResolvedValue({
        key: 'businesses/biz-123/products/uuid-test.jpg',
        uploadUrl: '/api/v1/media/upload?key=businesses/biz-123/products/uuid-test.jpg',
        downloadUrl: '/api/v1/media/file?key=...',
        publicUrl: '/api/v1/media/file?key=...',
      });

      const res = await controller.getPresignedUrl(tenant, {
        folder: 'products',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
      });

      expect(res.uploadUrl).toBeDefined();
      expect(mockStorageService.getPresignedUploadUrl).toHaveBeenCalledWith(
        'biz-123',
        'products',
        'test.jpg',
        'image/jpeg',
        1024,
      );
    });
  });
});

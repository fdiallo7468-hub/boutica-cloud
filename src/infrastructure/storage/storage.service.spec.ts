import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service';

describe('StorageService (Stockage Local Multi-Tenant Durci)', () => {
  let storageService: StorageService;
  const testDir = path.resolve('./uploads-test-hardened');

  // Buffers avec signatures binaires valides (magic bytes)
  const validPngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const validJpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const validPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const validCsvBuffer = Buffer.from('sku,name,price\nSKU-001,Produit 1,1500\n');

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'UPLOADS_DIR') return testDir;
        if (key === 'BETTER_AUTH_URL') return 'https://boutica.cloud';
        return undefined;
      }),
    };
    storageService = new StorageService(configService as any);
  });

  afterAll(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('Validation des types MIME et signatures binaires (Magic Bytes)', () => {
    it('devrait rejeter un type MIME non autorisé', async () => {
      await expect(
        storageService.getPresignedUploadUrl('tenant-1', 'products', 'malware.exe', 'application/x-msdownload'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier vide (0 octet)', async () => {
      await expect(
        storageService.uploadDirect('tenant-1', 'products', 'empty.png', Buffer.alloc(0), 'image/png'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier dépassant la limite maximale de 10 Mo', async () => {
      await expect(
        storageService.getPresignedUploadUrl('tenant-1', 'products', 'giant.jpg', 'image/jpeg', 11 * 1024 * 1024),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier dont le contenu ne correspond pas à la signature PNG déclarée (spoofing)', async () => {
      const fakePngBuffer = Buffer.from('ceci est un simple texte et non une image png');
      await expect(
        storageService.uploadDirect('tenant-1', 'products', 'fake.png', fakePngBuffer, 'image/png'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier exécutable dissimulé sous format CSV', async () => {
      const fakeCsvExecutable = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // En-tête MZ PE executable
      await expect(
        storageService.uploadDirect('tenant-1', 'products', 'fake.csv', fakeCsvExecutable, 'text/csv'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Sécurité Anti-Path Traversal & Isolation Multi-Tenant', () => {
    it('devrait bloquer l accès à un fichier d un autre tenant sans path traversal', async () => {
      await expect(
        storageService.getFile('tenant-attacker', 'businesses/tenant-victim/products/secret.pdf'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('devrait bloquer une tentative de path traversal sophistiquée avec .. vers un autre tenant', async () => {
      const maliciousKey = 'businesses/tenant-attacker/../../businesses/tenant-victim/products/secret.pdf';
      await expect(
        storageService.getFile('tenant-attacker', maliciousKey),
      ).rejects.toThrow(ForbiddenException);
    });

    it('devrait bloquer une tentative de path traversal vers la racine système (/etc/passwd)', async () => {
      const maliciousKey = 'businesses/tenant-attacker/../../../../etc/passwd';
      await expect(
        storageService.getFile('tenant-attacker', maliciousKey),
      ).rejects.toThrow(ForbiddenException);
    });

    it('devrait bloquer les clés avec null bytes', async () => {
      const maliciousKey = 'businesses/tenant-attacker/products/secret.pdf\0.jpg';
      await expect(
        storageService.getFile('tenant-attacker', maliciousKey),
      ).rejects.toThrow(ForbiddenException);
    });

    it('devrait bloquer les chemins absolus', async () => {
      const absoluteKey = '/etc/passwd';
      await expect(
        storageService.getFile('tenant-attacker', absoluteKey),
      ).rejects.toThrow(ForbiddenException);
    });

    it('devrait bloquer les businessId invalides ou malveillants', async () => {
      await expect(
        storageService.getPresignedUploadUrl('../../bad-tenant', 'products', 'photo.png', 'image/png'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Cohérence des URL et Contrats API', () => {
    it('devrait générer une URL d upload et de téléchargement cohérente avec les endpoints disponibles', async () => {
      const result = await storageService.getPresignedUploadUrl('tenant-123', 'products', 'photo.jpg', 'image/jpeg');

      expect(result.key).toContain('businesses/tenant-123/products/');
      expect(result.key).toContain('photo.jpg');
      expect(result.uploadUrl).toBe('https://boutica.cloud/api/v1/media/upload?folder=products');
      expect(result.downloadUrl).toContain('https://boutica.cloud/api/v1/media/file?key=');
      expect(result.publicUrl).toBe(result.downloadUrl);
    });
  });

  describe('Cycle de vie complet légitime (Upload, Lecture, Suppression)', () => {
    it('devrait uploader un fichier valide, permettre sa lecture par son propriétaire et sa suppression', async () => {
      // 1. Upload
      const upload = await storageService.uploadDirect(
        'tenant-alpha',
        'invoices',
        'facture.pdf',
        validPdfBuffer,
        'application/pdf',
      );

      expect(upload.key).toContain('businesses/tenant-alpha/invoices/');
      expect(upload.size).toBe(validPdfBuffer.length);
      expect(upload.url).toContain('/api/v1/media/file?key=');

      // 2. Lecture autorisée pour tenant-alpha
      const fileInfo = await storageService.getFile('tenant-alpha', upload.key);
      expect(fileInfo.mimeType).toBe('application/pdf');
      expect(fileInfo.filename).toContain('facture.pdf');
      expect(fs.existsSync(fileInfo.absolutePath)).toBe(true);

      // 3. Lecture refusée pour tenant-beta (ForbiddenException)
      await expect(storageService.getFile('tenant-beta', upload.key)).rejects.toThrow(ForbiddenException);

      // 4. Suppression refusée pour tenant-beta
      await expect(storageService.deleteFile('tenant-beta', upload.key)).rejects.toThrow(ForbiddenException);

      // 5. Suppression autorisée pour tenant-alpha
      const del = await storageService.deleteFile('tenant-alpha', upload.key);
      expect(del.success).toBe(true);
      expect(fs.existsSync(fileInfo.absolutePath)).toBe(false);

      // 6. Lecture après suppression -> NotFoundException
      await expect(storageService.getFile('tenant-alpha', upload.key)).rejects.toThrow(NotFoundException);
    });
  });
});

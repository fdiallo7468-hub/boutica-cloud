import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service';

describe('StorageService (Stockage Local Multi-Tenant Durci)', () => {
  let storageService: StorageService;
  const testDir = path.resolve('./uploads-test-security');

  const validPngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const validJpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const validPdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const validCsvBuffer = Buffer.from('sku,name,price\nSKU-001,Produit Test,1500\nSKU-002,Produit Épice,2500\n');

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

  describe('Contrat d Upload Cohérent (getPresignedUploadUrl & uploadDirect)', () => {
    it('devrait permettre à uploadDirect d honorer la clé préalablement réservée par getPresignedUploadUrl', async () => {
      // 1. Client demande une URL d upload pré-signée
      const presigned = await storageService.getPresignedUploadUrl(
        'tenant-mobile',
        'catalog',
        'telephone.png',
        'image/png',
      );

      expect(presigned.key).toBeDefined();
      expect(presigned.uploadUrl).toContain(encodeURIComponent(presigned.key));

      // 2. Client exécute l upload direct en fournissant la clé réservée
      const upload = await storageService.uploadDirect(
        'tenant-mobile',
        'catalog',
        'telephone.png',
        validPngBuffer,
        'image/png',
        presigned.key,
      );

      // 3. Vérification : la clé enregistrée est strictement identique à la clé annoncée
      expect(upload.key).toBe(presigned.key);
      expect(upload.url).toBe(presigned.publicUrl);

      // 4. Lecture immédiate avec la même clé
      const fileInfo = await storageService.getFile('tenant-mobile', presigned.key);
      expect(fileInfo.mimeType).toBe('image/png');
      expect(fs.existsSync(fileInfo.absolutePath)).toBe(true);
    });

    it('devrait refuser qu un client fournisse une expectedKey appartenant à un autre tenant', async () => {
      const victimKey = 'businesses/tenant-victim/catalog/secret.png';
      await expect(
        storageService.uploadDirect(
          'tenant-attacker',
          'catalog',
          'evil.png',
          validPngBuffer,
          'image/png',
          victimKey,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Validation Stricte des Fichiers CSV & Encodage UTF-8', () => {
    it('devrait valider un fichier CSV textuel encodé en UTF-8 propre avec caractères accentués', async () => {
      const upload = await storageService.uploadDirect(
        'tenant-csv',
        'reports',
        'export.csv',
        validCsvBuffer,
        'text/csv',
      );
      expect(upload.key).toContain('export.csv');
      const fileInfo = await storageService.getFile('tenant-csv', upload.key);
      expect(fileInfo.mimeType).toBe('text/csv');
    });

    it('devrait rejeter un fichier CSV contenant des séquences d octets UTF-8 invalides', async () => {
      // Séquence d octets invalide en UTF-8 (0xC0 0xAF ou continuation isolée 0x80)
      const invalidUtf8Buffer = Buffer.from([0x73, 0x6b, 0x75, 0x2c, 0xc0, 0xaf, 0x0a]);
      await expect(
        storageService.uploadDirect('tenant-csv', 'reports', 'bad-utf8.csv', invalidUtf8Buffer, 'text/csv'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier binaire avec octets nuls déguisé en CSV', async () => {
      const binaryWithNull = Buffer.from('col1,col2\nval1,\x00val2\n');
      await expect(
        storageService.uploadDirect('tenant-csv', 'reports', 'null-byte.csv', binaryWithNull, 'text/csv'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un exécutable ELF/MZ renommé en .csv', async () => {
      const fakeElfBuffer = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x01, 0x01, 0x00]);
      await expect(
        storageService.uploadDirect('tenant-csv', 'reports', 'malware.csv', fakeElfBuffer, 'text/csv'),
      ).rejects.toThrow(BadRequestException);
    });

    it('devrait rejeter un fichier CSV entièrement vide ou constitué uniquement d espaces', async () => {
      const emptyBuffer = Buffer.from('   \n\r\t  \n  ');
      await expect(
        storageService.uploadDirect('tenant-csv', 'reports', 'empty.csv', emptyBuffer, 'text/csv'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Protection Anti-Liens Symboliques (Symlinks)', () => {
    it('devrait refuser la lecture d un fichier qui est un lien symbolique vers un fichier sensible', async () => {
      const tenantId = 'tenant-symlink';
      const tenantDir = path.resolve(testDir, 'businesses', tenantId, 'general');
      fs.mkdirSync(tenantDir, { recursive: true });

      // Créer une cible légitime externe et un lien symbolique interne
      const outsideTarget = path.resolve(testDir, 'outside-secret.txt');
      fs.writeFileSync(outsideTarget, 'top_secret_data');

      const symlinkPath = path.resolve(tenantDir, 'symlink-attack.txt');
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      fs.symlinkSync(outsideTarget, symlinkPath);

      const symlinkKey = `businesses/${tenantId}/general/symlink-attack.txt`;

      await expect(storageService.getFile(tenantId, symlinkKey)).rejects.toThrow(ForbiddenException);

      // Nettoyage du symlink
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
    });

    it('devrait refuser l écriture si la cible existante est un lien symbolique', async () => {
      const tenantId = 'tenant-symlink-write';
      const tenantDir = path.resolve(testDir, 'businesses', tenantId, 'general');
      fs.mkdirSync(tenantDir, { recursive: true });

      const outsideTarget = path.resolve(testDir, 'outside-target.png');
      fs.writeFileSync(outsideTarget, validPngBuffer);

      const symlinkPath = path.resolve(tenantDir, 'pre-existing-symlink.png');
      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      fs.symlinkSync(outsideTarget, symlinkPath);

      const symlinkKey = `businesses/${tenantId}/general/pre-existing-symlink.png`;

      await expect(
        storageService.uploadDirect(
          tenantId,
          'general',
          'pre-existing-symlink.png',
          validPngBuffer,
          'image/png',
          symlinkKey,
        ),
      ).rejects.toThrow(ForbiddenException);

      if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
      if (fs.existsSync(outsideTarget)) fs.unlinkSync(outsideTarget);
    });
  });

  describe('Accès Concurrents & Écritures Atomiques', () => {
    it('devrait supporter des uploads concurrents sans corruption de données', async () => {
      const tenantId = 'tenant-concurrency';
      const concurrencyCount = 10;

      const uploadPromises = Array.from({ length: concurrencyCount }, (_, i) =>
        storageService.uploadDirect(
          tenantId,
          'parallel',
          `file-${i}.png`,
          validPngBuffer,
          'image/png',
        ),
      );

      const results = await Promise.all(uploadPromises);
      expect(results.length).toBe(concurrencyCount);

      // Vérifier que tous les fichiers sont lisibles et complets
      for (const res of results) {
        const fileInfo = await storageService.getFile(tenantId, res.key);
        expect(fileInfo.mimeType).toBe('image/png');
        expect(fs.existsSync(fileInfo.absolutePath)).toBe(true);
      }
    });

    it('devrait gérer gracieusement la suppression concurrente sans lever d erreur non maîtrisée', async () => {
      const tenantId = 'tenant-delete-concurrency';
      const upload = await storageService.uploadDirect(
        tenantId,
        'docs',
        'document.pdf',
        validPdfBuffer,
        'application/pdf',
      );

      // Deux suppressions concurrentes sur le même fichier
      const [del1, del2] = await Promise.all([
        storageService.deleteFile(tenantId, upload.key),
        storageService.deleteFile(tenantId, upload.key),
      ]);

      expect(del1.success).toBe(true);
      expect(del2.success).toBe(true);
    });
  });

  describe('Validation des types MIME et signatures binaires', () => {
    it('devrait rejeter un type MIME non autorisé', async () => {
      await expect(
        storageService.getPresignedUploadUrl('tenant-1', 'products', 'malware.exe', 'application/x-msdownload'),
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
  });

  describe('Sécurité Anti-Path Traversal', () => {
    it('devrait bloquer une tentative de path traversal sophistiquée avec .. vers un autre tenant', async () => {
      const maliciousKey = 'businesses/tenant-attacker/../../businesses/tenant-victim/products/secret.pdf';
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
  });
});

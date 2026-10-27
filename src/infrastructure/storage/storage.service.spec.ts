import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storage.service';

describe('StorageService (Stockage Local Zéro-Coût)', () => {
  let storageService: StorageService;
  const testDir = path.resolve('./uploads-test');

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'UPLOADS_DIR') return testDir;
        if (key === 'BETTER_AUTH_URL') return 'http://localhost:3000';
        return undefined;
      }),
    };
    storageService = new StorageService(configService as any);
  });

  afterAll(async () => {
    // Nettoyage du dossier de test
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  it('devrait rejeter un type MIME non autorisé', async () => {
    await expect(
      storageService.getPresignedUploadUrl('tenant-1', 'products', 'virus.exe', 'application/x-msdownload'),
    ).rejects.toThrow(BadRequestException);
  });

  it('devrait rejeter un fichier dépassant la limite de 10 Mo', async () => {
    await expect(
      storageService.getPresignedUploadUrl('tenant-1', 'products', 'large.jpg', 'image/jpeg', 11 * 1024 * 1024),
    ).rejects.toThrow(BadRequestException);
  });

  it('devrait générer une clé multi-tenant isolée pour les types autorisés', async () => {
    const result = await storageService.getPresignedUploadUrl('tenant-123', 'products', 'photo.jpg', 'image/jpeg');
    expect(result.key).toContain('businesses/tenant-123/products/');
    expect(result.key).toContain('photo.jpg');
    expect(result.uploadUrl).toBe('/api/v1/media/upload?folder=products');
    expect(result.publicUrl).toContain('/api/v1/media/file?key=');
  });

  it('devrait bloquer le téléchargement d un fichier appartenant à un autre locataire', async () => {
    await expect(
      storageService.getPresignedDownloadUrl('tenant-attacker', 'businesses/tenant-victim/products/secret.pdf'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('devrait bloquer la suppression d un fichier appartenant à un autre locataire', async () => {
    await expect(
      storageService.deleteFile('tenant-attacker', 'businesses/tenant-victim/products/secret.pdf'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('devrait uploader directement un fichier localement, permettre sa lecture puis le supprimer', async () => {
    const testBuffer = Buffer.from('Contenu de test pour upload média');
    const uploadResult = await storageService.uploadDirect(
      'tenant-123',
      'products',
      'mon-produit.png',
      testBuffer,
      'image/png',
    );

    expect(uploadResult.key).toContain('businesses/tenant-123/products/');
    expect(uploadResult.size).toBe(testBuffer.length);
    expect(uploadResult.url).toContain('/api/v1/media/file?key=');

    // Lecture du fichier
    const fileInfo = await storageService.getFile('tenant-123', uploadResult.key);
    expect(fileInfo.mimeType).toBe('image/png');
    expect(fs.existsSync(fileInfo.absolutePath)).toBe(true);

    // Suppression
    const deleteResult = await storageService.deleteFile('tenant-123', uploadResult.key);
    expect(deleteResult.success).toBe(true);
    expect(fs.existsSync(fileInfo.absolutePath)).toBe(false);

    // Lecture après suppression -> NotFoundException
    await expect(storageService.getFile('tenant-123', uploadResult.key)).rejects.toThrow(NotFoundException);
  });
});

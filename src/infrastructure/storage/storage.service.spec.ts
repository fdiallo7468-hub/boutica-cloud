import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('StorageService (Cloudflare R2)', () => {
  let storageService: StorageService;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'R2_BUCKET_NAME') return 'test-bucket';
        return undefined;
      }),
    } as unknown as ConfigService;
    storageService = new StorageService(configService as any);
  });

  it('devrait rejeter un type MIME non autorisé', async () => {
    await expect(
      storageService.getPresignedUploadUrl('tenant-1', 'products', 'virus.exe', 'application/x-msdownload'),
    ).rejects.toThrow(BadRequestException);
  });

  it('devrait générer une clé multi-tenant isolée pour les types autorisés', async () => {
    const result = await storageService.getPresignedUploadUrl('tenant-123', 'products', 'photo.jpg', 'image/jpeg');
    expect(result.key).toContain('businesses/tenant-123/products/');
    expect(result.key).toContain('photo.jpg');
    expect(result.uploadUrl).toBeDefined();
  });

  it('devrait bloquer le téléchargement d\'un fichier appartenant à un autre locataire', async () => {
    await expect(
      storageService.getPresignedDownloadUrl('tenant-attacker', 'businesses/tenant-victim/products/secret.pdf'),
    ).rejects.toThrow(ForbiddenException);
  });
});

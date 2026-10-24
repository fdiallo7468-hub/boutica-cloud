import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { Env } from '../../config/env.schema';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/csv',
];

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client | null = null;
  private readonly bucketName: string;
  private readonly publicBaseUrl: string | null;
  private readonly isConfigured: boolean = false;

  constructor(private readonly config: ConfigService<Env, true>) {
    const accountId = this.config.get('R2_ACCOUNT_ID', { infer: true });
    const accessKeyId = this.config.get('R2_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = this.config.get('R2_SECRET_ACCESS_KEY', { infer: true });
    const bucket = this.config.get('R2_BUCKET_NAME', { infer: true });
    const publicUrl = this.config.get('R2_PUBLIC_URL', { infer: true });

    this.bucketName = bucket || 'boutica-media';
    this.publicBaseUrl = publicUrl || null;

    if (accountId && accessKeyId && secretAccessKey) {
      this.s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.isConfigured = true;
      this.logger.log(`Cloudflare R2 Storage initialisé avec le bucket '${this.bucketName}'`);
    } else {
      this.logger.log('Identifiants R2 non configurés — StorageService fonctionne en mode mock/simulation');
    }
  }

  get configured(): boolean {
    return this.isConfigured;
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-');
  }

  private buildKey(businessId: string, folder = 'general', filename: string): string {
    const cleanFolder = folder.replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanName = this.sanitizeFilename(filename);
    const uuid = randomUUID();
    return `businesses/${businessId}/${cleanFolder}/${uuid}-${cleanName}`;
  }

  async getPresignedUploadUrl(
    businessId: string,
    folder = 'products',
    filename: string,
    mimeType: string,
    sizeBytes?: number,
  ): Promise<{ key: string; uploadUrl: string; publicUrl: string }> {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Type MIME non supporté : ${mimeType}. Formats autorisés : ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    if (sizeBytes && sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Taille de fichier excessive (${sizeBytes} octets). Limite maximale : 10 Mo`,
      );
    }

    const key = this.buildKey(businessId, folder, filename);

    if (!this.isConfigured || !this.s3) {
      const mockUrl = `https://mock-r2.boutica.cloud/${key}`;
      return {
        key,
        uploadUrl: mockUrl,
        publicUrl: mockUrl,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3, command, { expiresIn: 900 }); // 15 minutes
    const publicUrl = (this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : uploadUrl.split('?')[0]) || uploadUrl;

    return { key, uploadUrl, publicUrl };
  }

  async uploadDirect(
    businessId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ key: string; url: string; size: number }> {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(`Type MIME invalide: ${mimeType}`);
    }

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(`Fichier trop lourd (${buffer.length} octets). Max: 10 Mo`);
    }

    const key = this.buildKey(businessId, folder, filename);

    if (this.isConfigured && this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
    } else {
      this.logger.debug(`[Simulation] Upload direct exécuté pour ${key} (${buffer.length} octets)`);
    }

    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : `https://${this.bucketName}.r2.cloudflarestorage.com/${key}`;

    return { key, url, size: buffer.length };
  }

  async getPresignedDownloadUrl(businessId: string, key: string): Promise<string> {
    if (!key.startsWith(`businesses/${businessId}/`)) {
      throw new ForbiddenException('Accès refusé : ce fichier appartient à un autre compte');
    }

    if (!this.isConfigured || !this.s3) {
      return `https://mock-r2.boutica.cloud/${key}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    return getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }

  async deleteFile(businessId: string, key: string): Promise<{ success: boolean }> {
    if (!key.startsWith(`businesses/${businessId}/`)) {
      throw new ForbiddenException('Suppression interdite : fichier hors de votre périmètre');
    }

    if (this.isConfigured && this.s3) {
      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );
    } else {
      this.logger.debug(`[Simulation] Suppression de ${key}`);
    }

    return { success: true };
  }
}

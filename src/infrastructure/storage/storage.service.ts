import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Env } from '../../config/env.schema';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/csv',
];

const MIME_EXTENSION_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * StorageService — Stockage local zéro-coût sécurisé multi-tenant
 * Remplace l'intégration Cloudflare R2 externe sans coût supplémentaire.
 * Les fichiers sont stockés dans le système de fichiers local du serveur
 * avec isolation stricte par businessId et protection anti-traversée de chemin.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly baseDir: string;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly config?: ConfigService<Env, true>) {
    const customDir = this.config?.get?.('UPLOADS_DIR' as any, { infer: true });
    this.baseDir = path.resolve(customDir || './uploads');

    // Assurer que le dossier de base existe
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      this.logger.log(`Stockage local zéro-coût initialisé dans '${this.baseDir}'`);
    } catch (err: any) {
      this.logger.warn(`Impossible de créer le dossier de stockage '${this.baseDir}': ${err.message}`);
    }

    const publicUrl = this.config?.get?.('BETTER_AUTH_URL' as any, { infer: true });
    this.publicBaseUrl = publicUrl || null;
  }

  get configured(): boolean {
    return true;
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

  private buildFileUrl(key: string): string {
    const relativeUrl = `/api/v1/media/file?key=${encodeURIComponent(key)}`;
    return this.publicBaseUrl ? `${this.publicBaseUrl}${relativeUrl}` : relativeUrl;
  }

  private validateTenantAccess(businessId: string, key: string): void {
    const expectedPrefix = `businesses/${businessId}/`;
    if (!key.startsWith(expectedPrefix)) {
      throw new ForbiddenException(`Accès refusé : la ressource '${key}' n'appartient pas à votre entreprise`);
    }
  }

  private validateMimeType(mimeType: string): void {
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(
        `Format de fichier '${mimeType}' non autorisé. Formats acceptés : JPEG, PNG, WEBP, GIF, PDF, CSV.`,
      );
    }
  }

  private validateFileSize(sizeBytes: number): void {
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Fichier trop volumineux (${(sizeBytes / 1024 / 1024).toFixed(1)} Mo). Limite : 10 Mo.`,
      );
    }
  }

  private getExtension(filename: string): string {
    const ext = filename.lastIndexOf('.') !== -1 ? filename.slice(filename.lastIndexOf('.')) : '';
    return ext.toLowerCase();
  }

  private resolveSafeFilePath(key: string): string {
    const normalized = path.normalize(key).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.resolve(this.baseDir, normalized);
    const resolvedBase = path.resolve(this.baseDir);

    if (!fullPath.startsWith(resolvedBase)) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }
    return fullPath;
  }

  async getPresignedUploadUrl(
    businessId: string,
    folder = 'products',
    filename: string,
    mimeType: string,
    sizeBytes?: number,
  ): Promise<{ key: string; uploadUrl: string; publicUrl: string }> {
    this.validateMimeType(mimeType);
    if (sizeBytes !== undefined) {
      this.validateFileSize(sizeBytes);
    }

    const key = this.buildKey(businessId, folder, filename);
    const uploadUrl = `/api/v1/media/upload?folder=${encodeURIComponent(folder)}`;
    const publicUrl = this.buildFileUrl(key);

    return { key, uploadUrl, publicUrl };
  }

  async uploadDirect(
    businessId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ key: string; url: string; size: number }> {
    this.validateMimeType(mimeType);
    this.validateFileSize(buffer.length);

    const key = this.buildKey(businessId, folder, filename);
    const filePath = this.resolveSafeFilePath(key);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(filePath, buffer);
    this.logger.log(`Fichier enregistré avec succès : ${key} (${buffer.length} octets)`);

    return {
      key,
      url: this.buildFileUrl(key),
      size: buffer.length,
    };
  }

  async getPresignedDownloadUrl(businessId: string, key: string): Promise<string> {
    this.validateTenantAccess(businessId, key);
    return this.buildFileUrl(key);
  }

  async getFile(
    businessId: string,
    key: string,
  ): Promise<{ absolutePath: string; mimeType: string; filename: string }> {
    this.validateTenantAccess(businessId, key);
    const filePath = this.resolveSafeFilePath(key);

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Le fichier '${key}' est introuvable sur le serveur`);
    }

    const ext = this.getExtension(filePath);
    const mimeType = MIME_EXTENSION_MAP[ext] || 'application/octet-stream';

    return {
      absolutePath: filePath,
      mimeType,
      filename: path.basename(filePath),
    };
  }

  async deleteFile(businessId: string, key: string): Promise<{ success: boolean }> {
    this.validateTenantAccess(businessId, key);
    const filePath = this.resolveSafeFilePath(key);

    if (fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
        this.logger.log(`Fichier supprimé : ${key}`);
      } catch (err: any) {
        this.logger.warn(`Erreur lors de la suppression du fichier '${key}': ${err.message}`);
      }
    }

    return { success: true };
  }
}

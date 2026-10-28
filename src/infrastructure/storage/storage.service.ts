import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Env } from '../../config/env.schema';

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/csv',
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const MIME_EXTENSION_MAP: Record<string, AllowedMimeType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 Mo

const BUSINESS_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const FOLDER_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * StorageService — Stockage local multi-tenant durci et sécurisé
 * 
 * Garantit :
 * 1. Une isolation multi-tenant stricte basée sur path.relative() (aucun accès interentreprises).
 * 2. Une protection absolue contre les traversées de chemin (path traversal, .., segments absolus).
 * 3. Une validation stricte des signatures binaires (magic bytes) pour empêcher le spoofing d'extension.
 * 4. Une cohérence parfaite des URL d'upload et de téléchargement.
 * 5. Une gestion propre des erreurs de système de fichiers.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly baseDir: string;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly config?: ConfigService<Env, true>) {
    const customDir = this.config?.get?.('UPLOADS_DIR' as any, { infer: true });
    this.baseDir = path.resolve(customDir || './uploads');

    // Initialisation sécurisée du dossier de base
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      this.logger.log(`Stockage local sécurisé initialisé dans '${this.baseDir}'`);
    } catch (err: any) {
      this.logger.error(`Impossible d'initialiser le dossier de stockage '${this.baseDir}': ${err.message}`);
    }

    const publicUrl = this.config?.get?.('BETTER_AUTH_URL' as any, { infer: true });
    this.publicBaseUrl = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  }

  get configured(): boolean {
    return true;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private validateBusinessId(businessId: string): void {
    if (!businessId || typeof businessId !== 'string' || !BUSINESS_ID_REGEX.test(businessId)) {
      throw new BadRequestException('Identifiant entreprise invalide');
    }
  }

  private validateFolder(folder: string): string {
    const clean = (folder || 'general').trim();
    if (!FOLDER_REGEX.test(clean)) {
      throw new BadRequestException('Nom de dossier invalide (caractères alphanumériques, tirets et underscores uniquement)');
    }
    return clean;
  }

  private sanitizeFilename(filename: string): string {
    if (!filename || typeof filename !== 'string') {
      return 'unnamed-file';
    }
    const basename = path.basename(filename);
    const ext = this.getExtension(basename);
    const nameWithoutExt = basename.slice(0, basename.length - ext.length);

    const cleanName = nameWithoutExt
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80);

    return `${cleanName || 'file'}${ext}`;
  }

  private buildKey(businessId: string, folder = 'general', filename: string): string {
    this.validateBusinessId(businessId);
    const cleanFolder = this.validateFolder(folder);
    const cleanName = this.sanitizeFilename(filename);
    const uuid = randomUUID();
    return `businesses/${businessId}/${cleanFolder}/${uuid}-${cleanName}`;
  }

  private buildFileUrl(key: string): string {
    const relativeUrl = `/api/v1/media/file?key=${encodeURIComponent(key)}`;
    return this.publicBaseUrl ? `${this.publicBaseUrl}${relativeUrl}` : relativeUrl;
  }

  /**
   * Vérifie et résout de manière étanche le chemin d'accès au fichier pour un tenant donné.
   * Utilise path.posix.normalize() et path.relative() pour empêcher tout path traversal ou cross-tenant access.
   */
  resolveSafeFilePath(businessId: string, key: string): string {
    this.validateBusinessId(businessId);

    if (!key || typeof key !== 'string') {
      throw new BadRequestException('Clé de fichier requise');
    }

    // Décodage si la clé a été URL-encodée
    let decodedKey = key;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      throw new BadRequestException('Clé de fichier malformée');
    }

    // Rejet immédiat des caractères dangereux et tentatives de traversée évidentes
    if (
      decodedKey.includes('\0') ||
      decodedKey.includes('\\') ||
      decodedKey.startsWith('/') ||
      path.isAbsolute(decodedKey) ||
      decodedKey.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }

    // Normalisation POSIX stricte
    const normalizedKey = path.posix.normalize(decodedKey);

    // Vérification de sécurité post-normalisation
    if (
      normalizedKey.startsWith('/') ||
      normalizedKey.startsWith('../') ||
      normalizedKey.includes('/../') ||
      normalizedKey === '..'
    ) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }

    // Vérification que la clé normalisée commence strictement par le préfixe du tenant
    const expectedPrefix = `businesses/${businessId}/`;
    if (!normalizedKey.startsWith(expectedPrefix)) {
      throw new ForbiddenException(`Accès refusé : la ressource n'appartient pas à votre entreprise`);
    }

    // Résolution absolue
    const fullPath = path.resolve(this.baseDir, normalizedKey);
    const tenantBaseDir = path.resolve(this.baseDir, 'businesses', businessId);
    const resolvedBase = path.resolve(this.baseDir);

    // Vérification rigoureuse avec path.relative()
    const relToTenant = path.relative(tenantBaseDir, fullPath);
    if (relToTenant.startsWith('..') || path.isAbsolute(relToTenant)) {
      throw new ForbiddenException(`Accès refusé : fichier hors du périmètre de votre entreprise`);
    }

    const relToBase = path.relative(resolvedBase, fullPath);
    if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }

    return fullPath;
  }

  private validateMimeType(mimeType: string): void {
    if (!ALLOWED_MIME_TYPES.includes(mimeType as any)) {
      throw new BadRequestException(
        `Format de fichier '${mimeType}' non autorisé. Formats acceptés : JPEG, PNG, WEBP, GIF, PDF, CSV.`,
      );
    }
  }

  private validateFileSize(sizeBytes: number): void {
    if (sizeBytes <= 0) {
      throw new BadRequestException('Le fichier est vide (0 octet).');
    }
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

  /**
   * Vérifie la signature réelle (magic bytes) du buffer binaire.
   */
  validateFileSignature(buffer: Buffer, declaredMimeType: string): void {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Buffer de fichier vide');
    }

    switch (declaredMimeType) {
      case 'image/jpeg': {
        // JPEG commence par FF D8 FF
        if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format JPEG');
        }
        break;
      }
      case 'image/png': {
        // PNG commence par 89 50 4E 47 0D 0A 1A 0A
        const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if (buffer.length < 8 || !pngHeader.every((byte, idx) => buffer[idx] === byte)) {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format PNG');
        }
        break;
      }
      case 'image/gif': {
        // GIF commence par GIF87a ou GIF89a
        const header = buffer.toString('ascii', 0, 6);
        if (header !== 'GIF87a' && header !== 'GIF89a') {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format GIF');
        }
        break;
      }
      case 'image/webp': {
        // WEBP commence par RIFF à 0 et WEBP à 8
        if (buffer.length < 12) {
          throw new BadRequestException('Fichier WEBP trop court ou corrompu');
        }
        const riff = buffer.toString('ascii', 0, 4);
        const webp = buffer.toString('ascii', 8, 12);
        if (riff !== 'RIFF' || webp !== 'WEBP') {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format WEBP');
        }
        break;
      }
      case 'application/pdf': {
        // PDF commence par %PDF-
        const header = buffer.toString('ascii', 0, 5);
        if (header !== '%PDF-') {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format PDF');
        }
        break;
      }
      case 'text/csv': {
        // Rejette les exécutables (MZ / ELF) et les octets de contrôle binaires nuls
        if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
          throw new BadRequestException('Fichier binaire/exécutable non autorisé comme document CSV');
        }
        // Vérifie les premiers 512 octets pour détecter d'éventuels octets binaires nuls
        const sampleSize = Math.min(buffer.length, 512);
        for (let i = 0; i < sampleSize; i++) {
          if (buffer[i] === 0x00) {
            throw new BadRequestException('Fichier binaire non autorisé comme document CSV');
          }
        }
        break;
      }
      default:
        throw new BadRequestException(`Format MIME '${declaredMimeType}' non supporté pour la validation de signature`);
    }
  }

  async getPresignedUploadUrl(
    businessId: string,
    folder = 'products',
    filename: string,
    mimeType: string,
    sizeBytes?: number,
  ): Promise<{ key: string; uploadUrl: string; downloadUrl: string; publicUrl: string }> {
    this.validateBusinessId(businessId);
    this.validateMimeType(mimeType);
    if (sizeBytes !== undefined) {
      this.validateFileSize(sizeBytes);
    }

    const cleanFolder = this.validateFolder(folder);
    const key = this.buildKey(businessId, cleanFolder, filename);

    // URL cohérente : transmet le dossier dans la query string pour pré-remplir l'upload
    const baseEndpoint = this.publicBaseUrl ? `${this.publicBaseUrl}/api/v1/media` : '/api/v1/media';
    const uploadUrl = `${baseEndpoint}/upload?folder=${encodeURIComponent(cleanFolder)}`;
    const downloadUrl = this.buildFileUrl(key);

    return {
      key,
      uploadUrl,
      downloadUrl,
      publicUrl: downloadUrl,
    };
  }

  async uploadDirect(
    businessId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ key: string; url: string; size: number }> {
    this.validateBusinessId(businessId);
    this.validateMimeType(mimeType);
    this.validateFileSize(buffer.length);
    this.validateFileSignature(buffer, mimeType);

    const cleanFolder = this.validateFolder(folder);
    const key = this.buildKey(businessId, cleanFolder, filename);
    const filePath = this.resolveSafeFilePath(businessId, key);
    const dir = path.dirname(filePath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await fs.promises.writeFile(filePath, buffer);
    } catch (err: any) {
      this.logger.error(`Erreur d'écriture sur le disque local pour '${key}': ${err.message}`);
      throw new InternalServerErrorException('Erreur lors de l’écriture du fichier sur le stockage');
    }

    this.logger.log(`Média enregistré avec succès : ${key} (${buffer.length} octets)`);

    return {
      key,
      url: this.buildFileUrl(key),
      size: buffer.length,
    };
  }

  async getPresignedDownloadUrl(businessId: string, key: string): Promise<string> {
    // Valide le tenant et la conformité du chemin
    this.resolveSafeFilePath(businessId, key);
    return this.buildFileUrl(key);
  }

  async getFile(
    businessId: string,
    key: string,
  ): Promise<{ absolutePath: string; mimeType: string; filename: string }> {
    const filePath = this.resolveSafeFilePath(businessId, key);

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
    const filePath = this.resolveSafeFilePath(businessId, key);

    if (fs.existsSync(filePath)) {
      try {
        await fs.promises.unlink(filePath);
        this.logger.log(`Fichier média supprimé : ${key}`);
      } catch (err: any) {
        this.logger.error(`Erreur lors de la suppression de '${key}': ${err.message}`);
        throw new InternalServerErrorException('Erreur lors de la suppression du fichier');
      }
    }

    return { success: true };
  }
}

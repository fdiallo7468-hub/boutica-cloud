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
 * StorageService — Stockage local multi-tenant durci, atomique et sécurisé
 * 
 * Garanties de sécurité :
 * 1. Cohérence stricte du contrat d'upload : la clé réservée par getPresignedUploadUrl
 *    est respectée par uploadDirect(..., expectedKey).
 * 2. Isolation multi-tenant étanche avec path.relative() et path.posix.normalize().
 * 3. Protection absolue contre les liens symboliques (symlinks) via fs.lstat et fs.realpath.
 * 4. Protection contre les accès concurrents : écritures atomiques (fichier temporaire + rename POSIX).
 * 5. Validation binaire stricte (magic bytes) et validation UTF-8 irréprochable pour les fichiers CSV.
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

    let decodedKey = key;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      throw new BadRequestException('Clé de fichier malformée');
    }

    // Rejet immédiat des caractères dangereux et tentatives de traversée
    if (
      decodedKey.includes('\0') ||
      decodedKey.includes('\\') ||
      decodedKey.startsWith('/') ||
      path.isAbsolute(decodedKey) ||
      decodedKey.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }

    const normalizedKey = path.posix.normalize(decodedKey);

    if (
      normalizedKey.startsWith('/') ||
      normalizedKey.startsWith('../') ||
      normalizedKey.includes('/../') ||
      normalizedKey === '..'
    ) {
      throw new ForbiddenException('Tentative de traversée de chemin non autorisée');
    }

    const expectedPrefix = `businesses/${businessId}/`;
    if (!normalizedKey.startsWith(expectedPrefix)) {
      throw new ForbiddenException(`Accès refusé : la ressource n'appartient pas à votre entreprise`);
    }

    const fullPath = path.resolve(this.baseDir, normalizedKey);
    const tenantBaseDir = path.resolve(this.baseDir, 'businesses', businessId);
    const resolvedBase = path.resolve(this.baseDir);

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
   * Vérifie la signature réelle (magic bytes) et l'intégrité du contenu pour le type déclaré.
   */
  validateFileSignature(buffer: Buffer, declaredMimeType: string): void {
    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Buffer de fichier vide');
    }

    switch (declaredMimeType) {
      case 'image/jpeg': {
        if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format JPEG');
        }
        break;
      }
      case 'image/png': {
        const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if (buffer.length < 8 || !pngHeader.every((byte, idx) => buffer[idx] === byte)) {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format PNG');
        }
        break;
      }
      case 'image/gif': {
        const header = buffer.toString('ascii', 0, 6);
        if (header !== 'GIF87a' && header !== 'GIF89a') {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format GIF');
        }
        break;
      }
      case 'image/webp': {
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
        const header = buffer.toString('ascii', 0, 5);
        if (header !== '%PDF-') {
          throw new BadRequestException('La signature binaire du fichier ne correspond pas au format PDF');
        }
        break;
      }
      case 'text/csv': {
        // 1. Décodage UTF-8 strict (fatal: true rejette les séquences d'octets invalides)
        let textContent: string;
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true });
          textContent = decoder.decode(buffer);
        } catch {
          throw new BadRequestException('Le fichier CSV n\'est pas un document encodé en UTF-8 valide');
        }

        // 2. Rejet des exécutables (MZ Windows, ELF Linux, Mach-O macOS)
        if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
          throw new BadRequestException('Fichier binaire/exécutable MZ non autorisé comme document CSV');
        }
        if (buffer.length >= 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
          throw new BadRequestException('Fichier binaire ELF non autorisé comme document CSV');
        }

        // 3. Rejet des octets de contrôle binaires non textuels sur l'intégralité du contenu
        // Seuls \t (0x09), \n (0x0A), \r (0x0D) et les octets >= 0x20 sont autorisés
        for (let i = 0; i < buffer.length; i++) {
          const byte = buffer[i]!;
          if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            throw new BadRequestException('Le fichier CSV contient des octets de contrôle binaires non autorisés');
          }
        }

        // 4. Vérification d'un contenu minimal non vide
        if (textContent.trim().length === 0) {
          throw new BadRequestException('Le fichier CSV ne contient aucun contenu textuel imprimable');
        }
        break;
      }
      default:
        throw new BadRequestException(`Format MIME '${declaredMimeType}' non supporté pour la validation de signature`);
    }
  }

  /**
   * Génère une URL d'upload pré-signée et réserve la clé correspondante.
   * L'URL d'upload générée inclut la clé réservée (ex: /api/v1/media/upload?key=...)
   * garantissant un contrat cohérent entre l'annonce et l'upload effectif.
   */
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

    // Contrat d'upload cohérent : transmet la clé réservée dans l'uploadUrl
    const baseEndpoint = this.publicBaseUrl ? `${this.publicBaseUrl}/api/v1/media` : '/api/v1/media';
    const uploadUrl = `${baseEndpoint}/upload?key=${encodeURIComponent(key)}`;
    const downloadUrl = this.buildFileUrl(key);

    return {
      key,
      uploadUrl,
      downloadUrl,
      publicUrl: downloadUrl,
    };
  }

  /**
   * Upload direct avec écriture atomique et protection anti-liens symboliques.
   * Si expectedKey est fourni (réservation préalable), il est validé et réutilisé.
   */
  async uploadDirect(
    businessId: string,
    folder: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
    expectedKey?: string,
  ): Promise<{ key: string; url: string; downloadUrl: string; publicUrl: string; size: number }> {
    this.validateBusinessId(businessId);
    this.validateMimeType(mimeType);
    this.validateFileSize(buffer.length);
    this.validateFileSignature(buffer, mimeType);

    let key: string;
    if (expectedKey && typeof expectedKey === 'string' && expectedKey.trim() !== '') {
      // Validation stricte que la clé fournie appartient bien à ce tenant
      this.resolveSafeFilePath(businessId, expectedKey.trim());
      key = expectedKey.trim();
    } else {
      const cleanFolder = this.validateFolder(folder);
      key = this.buildKey(businessId, cleanFolder, filename);
    }

    const filePath = this.resolveSafeFilePath(businessId, key);
    const dir = path.dirname(filePath);

    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Vérification anti-symlink sur le dossier parent
      const dirLstat = await fs.promises.lstat(dir);
      if (dirLstat.isSymbolicLink()) {
        throw new ForbiddenException('Le dossier de destination est un lien symbolique non autorisé');
      }

      // Si le fichier existe déjà, vérifier qu'il ne s'agit pas d'un lien symbolique
      if (fs.existsSync(filePath)) {
        const fileLstat = await fs.promises.lstat(filePath);
        if (fileLstat.isSymbolicLink()) {
          throw new ForbiddenException('Écriture interdite sur un lien symbolique existant');
        }
      }

      // Écriture atomique : écriture dans un fichier temporaire unique puis renommage atomique POSIX
      const tempFilePath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(tempFilePath, buffer);
        await fs.promises.rename(tempFilePath, filePath);
      } finally {
        // Nettoyage sécurisé du temporaire s'il subsiste
        if (fs.existsSync(tempFilePath)) {
          await fs.promises.unlink(tempFilePath).catch(() => {});
        }
      }
    } catch (err: any) {
      if (err instanceof ForbiddenException || err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(`Erreur d'écriture sur le disque local pour '${key}': ${err.message}`);
      throw new InternalServerErrorException('Erreur lors de l’écriture du fichier sur le stockage');
    }

    this.logger.log(`Média enregistré avec succès : ${key} (${buffer.length} octets)`);
    const fileUrl = this.buildFileUrl(key);

    return {
      key,
      url: fileUrl,
      downloadUrl: fileUrl,
      publicUrl: fileUrl,
      size: buffer.length,
    };
  }

  async getPresignedDownloadUrl(businessId: string, key: string): Promise<string> {
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

    // Vérification stricte anti-lien symbolique
    const lstats = await fs.promises.lstat(filePath);
    if (lstats.isSymbolicLink()) {
      throw new ForbiddenException('Accès refusé : les liens symboliques sont strictement interdits');
    }

    // Vérification que le chemin réel canonique ne pointe pas hors du tenant
    const realFilePath = await fs.promises.realpath(filePath);
    const tenantBaseDir = path.resolve(this.baseDir, 'businesses', businessId);
    const relToTenant = path.relative(tenantBaseDir, realFilePath);
    if (relToTenant.startsWith('..') || path.isAbsolute(relToTenant)) {
      throw new ForbiddenException('Accès refusé : la cible résolue est hors du périmètre de l’entreprise');
    }

    const ext = this.getExtension(realFilePath);
    const mimeType = MIME_EXTENSION_MAP[ext] || 'application/octet-stream';

    return {
      absolutePath: realFilePath,
      mimeType,
      filename: path.basename(realFilePath),
    };
  }

  async deleteFile(businessId: string, key: string): Promise<{ success: boolean }> {
    const filePath = this.resolveSafeFilePath(businessId, key);

    if (fs.existsSync(filePath)) {
      try {
        const lstats = await fs.promises.lstat(filePath);
        if (lstats.isSymbolicLink()) {
          // Suppression sécurisée du lien sans suivre la cible
          await fs.promises.unlink(filePath);
          this.logger.warn(`Lien symbolique détecté et supprimé : ${key}`);
          return { success: true };
        }
        await fs.promises.unlink(filePath);
        this.logger.log(`Fichier média supprimé : ${key}`);
      } catch (err: any) {
        // Tolérance pour suppression concurrente (si déjà supprimé par un thread concurrent)
        if (err.code === 'ENOENT') {
          return { success: true };
        }
        this.logger.error(`Erreur lors de la suppression de '${key}': ${err.message}`);
        throw new InternalServerErrorException('Erreur lors de la suppression du fichier');
      }
    }

    return { success: true };
  }
}

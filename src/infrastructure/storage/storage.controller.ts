import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentTenant } from '../../modules/auth/current-tenant.decorator';
import { Tenant } from '../../modules/auth/tenant.type';
import { GetPresignedUrlDto } from './dto/get-presigned-url.dto';
import { MAX_FILE_SIZE_BYTES, StorageService } from './storage.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller('api/v1/media')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @ApiOperation({ summary: 'Obtenir une URL d upload direct depuis le client mobile ou web' })
  @Post('presigned-url')
  async getPresignedUrl(
    @CurrentTenant() tenant: Tenant,
    @Body() dto: GetPresignedUrlDto,
  ) {
    return this.storageService.getPresignedUploadUrl(
      tenant.businessId,
      dto.folder,
      dto.filename,
      dto.mimeType,
      dto.sizeBytes,
    );
  }

  @ApiOperation({ summary: 'Uploader directement un fichier média (images produits, documents)' })
  @ApiConsumes('multipart/form-data')
  @ApiQuery({ name: 'folder', required: false, description: 'Dossier de destination (ex: products, invoices)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: { type: 'string' },
      },
    },
  })
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: 1,
      },
    }),
  )
  async uploadFile(
    @CurrentTenant() tenant: Tenant,
    @UploadedFile() file?: Express.Multer.File,
    @Body('folder') bodyFolder?: string,
    @Query('folder') queryFolder?: string,
  ) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Aucun fichier fourni dans la requête (champ "file" requis)');
    }

    const folder = (bodyFolder || queryFolder || 'products').trim();

    return this.storageService.uploadDirect(
      tenant.businessId,
      folder,
      file.originalname,
      file.buffer,
      file.mimetype,
    );
  }

  @ApiOperation({ summary: 'Générer une URL de téléchargement sécurisée' })
  @Get('download-url')
  async getDownloadUrl(
    @CurrentTenant() tenant: Tenant,
    @Query('key') key: string,
  ) {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new BadRequestException('Paramètre "key" manquant ou invalide');
    }
    const url = await this.storageService.getPresignedDownloadUrl(tenant.businessId, key.trim());
    return { key: key.trim(), url };
  }

  @ApiOperation({ summary: 'Télécharger ou afficher directement un fichier média stocké' })
  @Get('file')
  async getFile(
    @CurrentTenant() tenant: Tenant,
    @Query('key') key: string,
    @Res() res: Response,
  ) {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new BadRequestException('Paramètre "key" manquant ou invalide');
    }
    const fileInfo = await this.storageService.getFile(tenant.businessId, key.trim());
    res.setHeader('Content-Type', fileInfo.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileInfo.filename)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(fileInfo.absolutePath);
  }

  @ApiOperation({ summary: 'Supprimer un média appartenant à son entreprise' })
  @Delete()
  async deleteFile(
    @CurrentTenant() tenant: Tenant,
    @Query('key') key: string,
  ) {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new BadRequestException('Paramètre "key" manquant ou invalide');
    }
    return this.storageService.deleteFile(tenant.businessId, key.trim());
  }
}

import type { Express } from 'express';
import 'multer';
import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../modules/auth/current-tenant.decorator';
import { Tenant } from '../../modules/auth/tenant.type';
import { GetPresignedUrlDto } from './dto/get-presigned-url.dto';
import { StorageService } from './storage.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller('api/v1/media')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @ApiOperation({ summary: 'Obtenir une URL pré-signée pour upload direct depuis le client mobile ou web' })
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
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @CurrentTenant() tenant: Tenant,
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder?: string,
  ) {
    return this.storageService.uploadDirect(
      tenant.businessId,
      folder || 'products',
      file.originalname,
      file.buffer,
      file.mimetype,
    );
  }

  @ApiOperation({ summary: 'Générer une URL de téléchargement pré-signée sécurisée' })
  @Get('download-url')
  async getDownloadUrl(
    @CurrentTenant() tenant: Tenant,
    @Query('key') key: string,
  ) {
    const url = await this.storageService.getPresignedDownloadUrl(tenant.businessId, key);
    return { key, url };
  }

  @ApiOperation({ summary: 'Supprimer un média appartenant à son entreprise' })
  @Delete()
  async deleteFile(
    @CurrentTenant() tenant: Tenant,
    @Query('key') key: string,
  ) {
    return this.storageService.deleteFile(tenant.businessId, key);
  }
}

import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetPresignedUrlDto {
  @IsString()
  filename!: string;

  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/csv'])
  mimeType!: string;

  @IsOptional()
  @IsString()
  folder?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10 * 1024 * 1024) // 10 MB max
  sizeBytes?: number;
}

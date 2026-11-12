import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class AdjustStockDto {
  @IsInt()
  @Min(0)
  quantity: number;

  // Required for positive stock adjustments; never inferred from catalog purchasePrice.
  @IsOptional()
  @IsString()
  @Matches(/^\\d+(?:\\.\\d{1,2})?$/)
  unitCost?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

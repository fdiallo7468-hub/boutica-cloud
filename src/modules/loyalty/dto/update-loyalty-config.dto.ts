import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateLoyaltyConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  earnPointsPer1000?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(1000000)
  pointValue?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minimumRedemptionPoints?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  expiryDays?: number | null;
}

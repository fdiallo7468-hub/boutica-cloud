import { IsBoolean, IsString, Matches, MaxLength } from 'class-validator';

export class PushDeviceDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^(Expo|Exponent)PushToken\[[^\]]+\]$/)
  token: string;

  @IsBoolean()
  stockAlerts: boolean;

  @IsBoolean()
  salesAlerts: boolean;
}

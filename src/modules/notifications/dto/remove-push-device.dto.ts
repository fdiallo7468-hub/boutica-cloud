import { IsString, Matches, MaxLength } from 'class-validator';

export class RemovePushDeviceDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^(Expo|Exponent)PushToken\[[^\]]+\]$/)
  token: string;
}

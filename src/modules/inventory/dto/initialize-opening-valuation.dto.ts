import { IsInt, IsString, Matches, Min } from 'class-validator';

export class InitializeOpeningValuationDto {
  @IsInt()
  @Min(0)
  quantity: number;

  @IsString()
  @Matches(/^\\d+(?:\\.\\d{1,2})?$/)
  unitCost: string;
}

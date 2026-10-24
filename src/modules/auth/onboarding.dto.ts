import { IsNotEmpty, IsOptional, IsString, Length, Matches } from "class-validator";

export class CompleteBusinessOnboardingDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 120)
  businessName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "La devise doit être un code ISO 4217 de 3 lettres majuscules (ex: XOF, EUR, USD)" })
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  businessPhone?: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  businessSector?: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  businessAddress?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  personalPhone?: string;
}

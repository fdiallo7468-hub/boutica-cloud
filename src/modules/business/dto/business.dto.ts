import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from "class-validator";
import { BUSINESS_SECTORS, BusinessSectorType } from "../business-taxonomy";

export class UpdateBusinessProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: "La devise doit être un code ISO 4217 de 3 lettres (ex: XOF, EUR, USD)",
  })
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  phone?: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  address?: string;

  @IsOptional()
  @IsString()
  @IsIn([BUSINESS_SECTORS.QUINCAILLERIE, BUSINESS_SECTORS.ELECTRONIQUE], {
    message: "Le secteur doit être 'QUINCAILLERIE' ou 'ELECTRONIQUE'",
  })
  sector?: BusinessSectorType;
}

export class UpdateActivitiesDto {
  @IsArray()
  @IsString({ each: true })
  activities!: string[];
}

export class ModuleConfigItemDto {
  @IsString()
  @IsNotEmpty()
  module!: string;

  @IsBoolean()
  isEnabled!: boolean;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class UpdateModulesDto {
  @IsArray()
  modules!: ModuleConfigItemDto[];
}

export class RegisterDeviceSerialDto {
  @IsString()
  @IsNotEmpty()
  variantId!: string;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  imei?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  warrantyMonths?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

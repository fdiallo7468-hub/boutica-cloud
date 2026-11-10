import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
} from "class-validator";

export class CreateBusinessLocationDto {
  @IsString()
  @Length(2, 20)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: "Le code doit contenir uniquement des lettres majuscules, chiffres, tirets ou underscores",
  })
  code!: string;

  @IsString()
  @Length(2, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  address?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateBusinessLocationDto {
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(2, 255)
  address?: string | null;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  phone?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

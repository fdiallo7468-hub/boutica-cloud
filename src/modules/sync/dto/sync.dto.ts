import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export enum DeviceTypeEnum {
  DESKTOP = 'DESKTOP',
  MOBILE = 'MOBILE',
}

export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  deviceId!: string;

  @IsEnum(DeviceTypeEnum)
  deviceType!: DeviceTypeEnum;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  appVersion?: string;
}

export class OfflineOperationItemDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 128)
  clientOperationId!: string;

  @IsString()
  @IsIn(['CREATE_CUSTOMER', 'CREATE_SALE', 'RECORD_PAYMENT', 'RECORD_EXPENSE'])
  operationType!: 'CREATE_CUSTOMER' | 'CREATE_SALE' | 'RECORD_PAYMENT' | 'RECORD_EXPENSE';

  @IsDateString()
  clientTimestamp!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class SyncPushDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 100)
  deviceId!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OfflineOperationItemDto)
  operations!: OfflineOperationItemDto[];
}

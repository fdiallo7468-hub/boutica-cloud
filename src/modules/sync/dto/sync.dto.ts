import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
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
  clientOperationId!: string;

  @IsString()
  @IsNotEmpty()
  operationType!: string; // 'CREATE_CUSTOMER', 'CREATE_SALE', 'RECORD_PAYMENT', 'RECORD_EXPENSE', etc.

  @IsString()
  @IsNotEmpty()
  clientTimestamp!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class SyncPushDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsArray()
  operations!: OfflineOperationItemDto[];
}

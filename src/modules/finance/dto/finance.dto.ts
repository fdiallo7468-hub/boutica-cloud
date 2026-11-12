import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  Length,
} from 'class-validator';

export enum PaymentMethodEnum {
  CASH = 'CASH',
  ORANGE_MONEY = 'ORANGE_MONEY',
  MOOV_MONEY = 'MOOV_MONEY',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CARD = 'CARD',
  WAVE = 'WAVE',
  OTHER = 'OTHER',
}

export enum SettlementModeEnum {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
  DEFERRED = 'DEFERRED',
}

export class CreatePaymentDto {
  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsOptional()
  @IsUUID()
  receivableId?: string;

  @IsOptional()
  @IsUUID()
  saleId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'Le montant du paiement doit être strictement supérieur à 0' })
  amount!: number;

  @IsEnum(PaymentMethodEnum, {
    message: 'Moyen de paiement invalide (autorisés: CASH, ORANGE_MONEY, MOOV_MONEY, BANK_TRANSFER, CARD, WAVE, OTHER)',
  })
  paymentMethod!: PaymentMethodEnum;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  transactionReference?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

export class CancelPaymentDto {
  @IsString()
  @IsNotEmpty()
  @Length(3, 255)
  reason!: string;
}

export class CreateReceivableFromSaleDto {
  @IsUUID()
  @IsNotEmpty()
  saleId!: string;

  @IsUUID()
  @IsNotEmpty()
  customerId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  totalAmount!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPaidNow!: number;

  @IsOptional()
  @IsEnum(PaymentMethodEnum)
  paymentMethod?: PaymentMethodEnum;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  transactionReference?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

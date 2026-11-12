import { Module } from '@nestjs/common';
import { PurchasingController } from './purchasing.controller';
import { ReceivePurchaseUseCase } from './application/receive-purchase.usecase';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [DatabaseModule, AccountingModule],
  controllers: [PurchasingController],
  providers: [ReceivePurchaseUseCase],
})
export class PurchasingModule {}

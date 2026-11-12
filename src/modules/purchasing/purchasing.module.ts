import { Module } from '@nestjs/common';
import { PurchasingController } from './purchasing.controller';
import { ReceivePurchaseUseCase } from './application/receive-purchase.usecase';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [DatabaseModule, AccountingModule, InventoryModule],
  controllers: [PurchasingController],
  providers: [ReceivePurchaseUseCase],
})
export class PurchasingModule {}

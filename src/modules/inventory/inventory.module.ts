import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryController } from './inventory.controller';
import { InventoryValuationService } from './inventory-valuation.service';

@Module({
  imports: [DatabaseModule, AccountingModule],
  controllers: [InventoryController],
  providers: [InventoryValuationService],
  exports: [InventoryValuationService],
})
export class InventoryModule {}

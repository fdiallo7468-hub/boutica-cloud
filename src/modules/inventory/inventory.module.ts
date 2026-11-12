import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { InventoryController } from './inventory.controller';
import { InventoryValuationService } from './inventory-valuation.service';

@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [InventoryValuationService],
  exports: [InventoryValuationService],
})
export class InventoryModule {}

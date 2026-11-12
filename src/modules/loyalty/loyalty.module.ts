import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyLedgerService } from './loyalty-ledger.service';

@Module({
  imports: [DatabaseModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyLedgerService],
  exports: [LoyaltyLedgerService],
})
export class LoyaltyModule {}

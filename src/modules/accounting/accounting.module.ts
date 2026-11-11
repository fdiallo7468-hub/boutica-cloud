import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingController } from './accounting.controller';
import { AccountingLedgerController } from './accounting-ledger.controller';
import { AccountingLedgerService } from './accounting-ledger.service';
import { AccountingOperationalPostingService } from './accounting-operational-posting.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AccountingController, AccountingLedgerController],
  providers: [AccountingLedgerService, AccountingOperationalPostingService],
  exports: [AccountingLedgerService, AccountingOperationalPostingService],
})
export class AccountingModule {}

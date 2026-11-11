import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AccountingController } from './accounting.controller';
import { AccountingLedgerController } from './accounting-ledger.controller';
import { AccountingLedgerService } from './accounting-ledger.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AccountingController, AccountingLedgerController],
  providers: [AccountingLedgerService],
  exports: [AccountingLedgerService],
})
export class AccountingModule {}

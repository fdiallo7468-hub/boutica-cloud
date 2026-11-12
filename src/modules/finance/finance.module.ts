import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [DatabaseModule, NotificationsModule, AccountingModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}

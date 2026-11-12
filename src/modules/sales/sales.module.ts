import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { AccountingModule } from '../accounting/accounting.module';
import { CreateSaleUseCase } from './application/create-sale.usecase';
import { CancelSaleUseCase } from './application/cancel-sale.usecase';
import { SalesController } from './sales.controller';

@Module({
  imports: [DatabaseModule, NotificationsModule, LoyaltyModule, AccountingModule],
  controllers: [SalesController],
  providers: [CreateSaleUseCase, CancelSaleUseCase],
  exports: [CreateSaleUseCase],
})
export class SalesModule {}

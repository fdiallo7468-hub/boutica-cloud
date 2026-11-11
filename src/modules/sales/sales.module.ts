import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { CreateSaleUseCase } from './application/create-sale.usecase';
import { SalesController } from './sales.controller';

@Module({
  imports: [DatabaseModule, NotificationsModule, LoyaltyModule],
  controllers: [SalesController],
  providers: [CreateSaleUseCase],
  exports: [CreateSaleUseCase],
})
export class SalesModule {}

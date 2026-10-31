import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SalesController } from './sales.controller';
import { CreateSaleUseCase } from './application/create-sale.usecase';

@Module({
  imports: [NotificationsModule],
  controllers: [SalesController],
  providers: [CreateSaleUseCase],
})
export class SalesModule {}

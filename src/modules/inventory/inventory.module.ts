import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryController } from './inventory.controller';

@Module({ imports: [NotificationsModule], controllers: [InventoryController] })
export class InventoryModule {}

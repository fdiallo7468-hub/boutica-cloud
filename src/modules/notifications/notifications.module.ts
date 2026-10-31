import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationsController } from './notifications.controller';
import { PushNotificationsService } from './push-notifications.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [PushNotificationsService],
  exports: [PushNotificationsService],
})
export class NotificationsModule {}

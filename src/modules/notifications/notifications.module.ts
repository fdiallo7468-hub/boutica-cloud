import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationsController } from './notifications.controller';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationOutboxProcessor } from './notification-outbox-processor.service';
import { NovuNotificationOrchestrator } from './novu-notification-orchestrator.service';
import { PushNotificationsService } from './push-notifications.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    PushNotificationsService,
    NovuNotificationOrchestrator,
    NotificationDeliveryService,
    NotificationOutboxProcessor,
  ],
  exports: [PushNotificationsService],
})
export class NotificationsModule {}

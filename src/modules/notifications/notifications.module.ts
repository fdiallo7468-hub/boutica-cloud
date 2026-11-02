import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NotificationsController } from './notifications.controller';
import { NovuClientService } from './novu-client.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    NovuClientService,
    NotificationOutboxService,
    NotificationOutboxWorker,
  ],
  exports: [NovuClientService, NotificationOutboxService],
})
export class NotificationsModule {}

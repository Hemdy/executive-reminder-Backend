import { Module } from '@nestjs/common';
import {
  NotificationsController,
  PushConfigController,
  PushCronController,
  PushCronGuard,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushQueueService } from './push-queue.service';

@Module({
  controllers: [NotificationsController, PushConfigController, PushCronController],
  providers: [NotificationsService, PushQueueService, PushCronGuard],
  exports: [NotificationsService, PushQueueService],
})
export class NotificationsModule {}

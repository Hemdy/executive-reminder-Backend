import { Module } from '@nestjs/common';
import {
  NotificationsController,
  PushConfigController,
  PushCronController,
  PushCronGuard,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController, PushConfigController, PushCronController],
  providers: [NotificationsService, PushCronGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}

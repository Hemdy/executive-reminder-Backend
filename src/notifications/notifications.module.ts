import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  NotificationsController,
  PushConfigController,
  PushCronController,
  PushCronGuard,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController, PushConfigController, PushCronController],
  providers: [NotificationsService, PrismaService, PushCronGuard],
  exports: [NotificationsService],
})
export class NotificationsModule {}

import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [AdminController],
})
export class AdminModule {}

import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TaskAttachmentStorageService } from '../tasks/task-attachment-storage.service';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  imports: [NotificationsModule],
  controllers: [RequestsController],
  providers: [RequestsService, TaskAttachmentStorageService],
})
export class RequestsModule {}

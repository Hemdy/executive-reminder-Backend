import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma.service';
import { TaskAttachmentStorageService } from './task-attachment-storage.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskAttachmentStorageService, PrismaService]
})
export class TasksModule {}

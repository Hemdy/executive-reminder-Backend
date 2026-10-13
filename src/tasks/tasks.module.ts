import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TaskAttachmentStorageService } from './task-attachment-storage.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskAttachmentStorageService, PrismaService]
})
export class TasksModule {}

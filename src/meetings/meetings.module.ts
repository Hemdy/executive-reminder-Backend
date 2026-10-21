import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma.service';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';

@Module({
  imports: [NotificationsModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, PrismaService],
})
export class MeetingsModule {}

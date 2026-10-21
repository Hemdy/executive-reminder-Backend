import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma.service';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

@Module({
  imports: [NotificationsModule],
  controllers: [RemindersController],
  providers: [RemindersService, PrismaService],
})
export class RemindersModule {}

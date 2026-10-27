import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { MeetingsModule } from './meetings/meetings.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma.module';
import { RemindersModule } from './reminders/reminders.module';
import { RequestsModule } from './requests/requests.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AdminModule,
    TasksModule,
    RemindersModule,
    RequestsModule,
    MeetingsModule,
    NotificationsModule,
  ],
})
export class AppModule {}

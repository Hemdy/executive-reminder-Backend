import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { NotificationType, Priority } from '@prisma/client';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { NotificationsService } from './notifications.service';

class PushKeysDto {
  @IsString() @Length(1, 256) p256dh!: string;
  @IsString() @Length(1, 256) auth!: string;
}

class PushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) @Length(1, 2048) endpoint!: string;
  @IsOptional() @IsInt() expirationTime?: number | null;
  @ValidateNested() @Type(() => PushKeysDto) keys!: PushKeysDto;
}

class RemovePushSubscriptionDto {
  @IsUrl({ protocols: ['https'], require_protocol: true }) endpoint!: string;
}

class NotificationDto {
  @IsString() title!: string;
  @IsString() message!: string;
  @IsEnum(NotificationType) type!: NotificationType;
  @IsEnum(Priority) priority!: Priority;
  @IsOptional() @IsString() sourceId?: string;
  @IsOptional() @IsString() referenceId?: string;
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsString() route?: string;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@Req() request: any) { return this.service.list(request.user.id); }
  @Post('push/subscription')
  savePushSubscription(@Body() dto: PushSubscriptionDto, @Req() request: any) {
    return this.service.savePushSubscription(request.user.id, dto);
  }
  @Delete('push/subscription')
  removePushSubscription(@Body() dto: RemovePushSubscriptionDto, @Req() request: any) {
    return this.service.removePushSubscription(request.user.id, dto.endpoint);
  }
  @Post() @Permissions('notifications:write') create(@Body() dto: NotificationDto, @Req() request: any) { return this.service.create(dto, request.user.id); }
  @Patch(':id/read') read(@Param('id') id: string, @Req() request: any) { return this.service.setRead(id, request.user.id, true); }
  @Patch(':id/unread') unread(@Param('id') id: string, @Req() request: any) { return this.service.setRead(id, request.user.id, false); }
  @Patch('read-all') all(@Req() request: any) { return this.service.markAllRead(request.user.id); }
  @Delete('read') clearRead(@Req() request: any) { return this.service.clearRead(request.user.id); }
  @Delete(':id') remove(@Param('id') id: string, @Req() request: any) { return this.service.remove(id, request.user.id); }
}

@Controller('notifications/push')
export class PushConfigController {
  constructor(private readonly service: NotificationsService) {}

  @Get('config')
  pushConfig() {
    return this.service.pushConfig();
  }
}

export class PushCronGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.get<string>('CRON_SECRET');
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authorization = request.headers.authorization;
    const expected = secret ? Buffer.from(`Bearer ${secret}`) : Buffer.alloc(0);
    const actual = authorization ? Buffer.from(authorization) : Buffer.alloc(0);
    if (!secret || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Controller('notifications/push')
@UseGuards(PushCronGuard)
export class PushCronController {
  constructor(private readonly service: NotificationsService) {}

  @Get('dispatch')
  async dispatch() {
    const dueReminders = await this.service.dispatchDueReminders();
    const deliveredPushes = await this.service.dispatchPendingPushNotifications();
    return { dueReminders, deliveredPushes };
  }
}

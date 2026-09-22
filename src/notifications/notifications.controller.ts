import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { NotificationType, Priority } from '@prisma/client';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { NotificationsService } from './notifications.service';

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
  @Post() @Permissions('notifications:write') create(@Body() dto: NotificationDto, @Req() request: any) { return this.service.create(dto, request.user.id); }
  @Patch(':id/read') read(@Param('id') id: string, @Req() request: any) { return this.service.setRead(id, request.user.id, true); }
  @Patch(':id/unread') unread(@Param('id') id: string, @Req() request: any) { return this.service.setRead(id, request.user.id, false); }
  @Patch('read-all') all(@Req() request: any) { return this.service.markAllRead(request.user.id); }
  @Delete('read') clearRead(@Req() request: any) { return this.service.clearRead(request.user.id); }
  @Delete(':id') remove(@Param('id') id: string, @Req() request: any) { return this.service.remove(id, request.user.id); }
}

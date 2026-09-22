import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { MeetingStatus, MeetingType } from '@prisma/client';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { MeetingsService } from './meetings.service';

class MeetingDto {
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() agenda?: string;
  @IsArray() @IsString({ each: true }) participantIds!: string[];
  @IsDateString() meetingDate!: string;
  @IsString() startTime!: string;
  @IsString() endTime!: string;
  @IsOptional() @IsString() location?: string;
  @IsEnum(MeetingType) meetingType!: MeetingType;
}

class UpdateMeetingDto extends MeetingDto {
  @IsEnum(MeetingStatus) status!: MeetingStatus;
}

@Controller('meetings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}
  @Get() @Permissions('meetings:read') list(@Req() req: any) { return this.service.list(req.user.id); }
  @Post() @Permissions('meetings:write') create(@Body() dto: MeetingDto, @Req() req: any) { return this.service.create(dto, req.user.id); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Patch(':id') @Permissions('meetings:write') update(@Param('id') id: string, @Body() dto: UpdateMeetingDto) { return this.service.update(id, dto); }
  @Patch(':id/status') @Permissions('meetings:write') status(@Param('id') id: string, @Body('status') status: string) { return this.service.status(id, status); }
  @Delete(':id') @Permissions('meetings:write') remove(@Param('id') id: string) { return this.service.remove(id); }
}

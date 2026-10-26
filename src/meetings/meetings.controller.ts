import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { IsArray, IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { MeetingStatus, MeetingType } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname } from 'node:path';
import type { Response } from 'express';
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

class MeetingStatusDto {
  @IsEnum(MeetingStatus) status!: MeetingStatus;
}

class MeetingCommentDto {
  @IsString() @MaxLength(5000) body!: string;
}

const allowedAttachmentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

interface UploadedMeetingFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('meetings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MeetingsController {
  constructor(private readonly service: MeetingsService) {}
  @Get() @Permissions('meetings:read') list(@Req() req: any) { return this.service.list(req.user.id); }
  @Post() @Permissions('meetings:write') create(@Body() dto: MeetingDto, @Req() req: any) { return this.service.create(dto, req.user.id); }
  @Get(':id') get(@Param('id') id: string, @Req() req: any) { return this.service.get(id, req.user.id); }
  @Get(':id/comments') comments(@Param('id') id: string, @Req() req: any) { return this.service.listComments(id, req.user.id); }
  @Post(':id/comments') addComment(@Param('id') id: string, @Body() dto: MeetingCommentDto, @Req() req: any) { return this.service.addComment(id, req.user.id, dto.body); }
  @Get(':id/attachments') attachments(@Param('id') id: string, @Req() req: any) { return this.service.listAttachments(id, req.user.id); }
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      const extension = extname(file.originalname).toLowerCase();
      const expectedMimeType = allowedAttachmentTypes.get(extension);
      if (!expectedMimeType || (file.mimetype !== expectedMimeType && file.mimetype !== 'application/octet-stream')) {
        callback(new BadRequestException('Only PDF and Word documents are supported'), false);
        return;
      }
      callback(null, true);
    },
  }))
  addAttachment(@Param('id') id: string, @Req() req: any, @UploadedFile() file: UploadedMeetingFile | undefined) {
    if (!file) {
      throw new BadRequestException('Choose a supported attachment to upload');
    }
    return this.service.addAttachment(id, req.user.id, file);
  }
  @Get(':id/attachments/:attachmentId')
  async downloadAttachment(
    @Param('id') meetingId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
    @Res() response: Response,
  ) {
    const attachment = await this.service.getAttachment(meetingId, attachmentId, req.user.id);
    const asciiFileName = attachment.fileName.replace(/[\r\n"]/g, '_').replace(/[^\x20-\x7e]/g, '_');
    response.setHeader('Content-Disposition', `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    response.setHeader('Content-Type', attachment.mimeType);
    response.setHeader('Content-Length', attachment.size);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(attachment.content);
  }
  @Patch(':id') @Permissions('meetings:write') update(@Param('id') id: string, @Body() dto: UpdateMeetingDto, @Req() req: any) { return this.service.update(id, dto, req.user.id); }
  @Patch(':id/status') @Permissions('meetings:write') status(@Param('id') id: string, @Body() dto: MeetingStatusDto, @Req() req: any) { return this.service.status(id, dto.status, req.user.id); }
  @Delete(':id') @Permissions('meetings:write') remove(@Param('id') id: string, @Req() req: any) { return this.service.remove(id, req.user.id); }
}

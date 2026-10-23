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
import { FileInterceptor } from '@nestjs/platform-express';
import { extname } from 'node:path';
import type { Response } from 'express';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { ReminderCommentDto, ReminderDto, ReminderStatusDto, UpdateReminderDto } from './reminder.dto';
import { RemindersService } from './reminders.service';

const allowedAttachmentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

interface UploadedReminderFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('reminders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RemindersController {
  constructor(private readonly s: RemindersService) {}

  @Get() @Permissions('reminders:read') list(@Req() r: any) { return this.s.list(r.user.id); }
  @Post() @Permissions('reminders:write') create(@Body() d: ReminderDto, @Req() r: any) { return this.s.create(d, r.user.id); }
  @Get(':id') get(@Param('id') id: string, @Req() req: any) { return this.s.get(id, req.user.id); }
  @Patch(':id') @Permissions('reminders:write') update(@Param('id') id: string, @Body() d: UpdateReminderDto) { return this.s.update(id, d); }
  @Patch(':id/status') @Permissions('reminders:write') status(@Param('id') id: string, @Body() dto: ReminderStatusDto) { return this.s.status(id, dto.status); }

  @Get(':id/comments') comments(@Param('id') id: string, @Req() req: any) { return this.s.listComments(id, req.user.id); }
  @Post(':id/comments') addComment(@Param('id') id: string, @Body() dto: ReminderCommentDto, @Req() req: any) { return this.s.addComment(id, req.user.id, dto.body); }
  @Get(':id/attachments') attachments(@Param('id') id: string, @Req() req: any) { return this.s.listAttachments(id, req.user.id); }
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
  addAttachment(@Param('id') id: string, @Req() req: any, @UploadedFile() file: UploadedReminderFile | undefined) {
    if (!file) {
      throw new BadRequestException('Choose a supported attachment to upload');
    }
    return this.s.addAttachment(id, req.user.id, file);
  }

  @Get(':id/attachments/:attachmentId')
  async downloadAttachment(
    @Param('id') reminderId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
    @Res() response: Response,
  ) {
    const attachment = await this.s.getAttachment(reminderId, attachmentId, req.user.id);
    const asciiFileName = attachment.fileName.replace(/[\r\n"]/g, '_').replace(/[^\x20-\x7e]/g, '_');
    response.setHeader('Content-Disposition', `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    response.setHeader('Content-Type', attachment.mimeType);
    response.setHeader('Content-Length', attachment.size);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(attachment.content);
  }

  @Delete(':id') @Permissions('reminders:write') remove(@Param('id') id: string) { return this.s.remove(id); }
}

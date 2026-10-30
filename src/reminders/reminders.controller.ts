import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import type { Response } from 'express';
import {
  attachmentMulterOptions,
  sendAttachment,
  UploadedAttachmentFile,
} from '../common/attachment-response';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { ReminderCommentDto, ReminderDto, ReminderStatusDto, UpdateReminderDto } from './reminder.dto';
import { RemindersService } from './reminders.service';

@Controller('reminders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RemindersController {
  constructor(private readonly s: RemindersService) {}

  @Get() @Permissions('reminders:read') list(@Req() r: any) { return this.s.list(r.user.id); }
  @Post() @Permissions('reminders:write') create(@Body() d: ReminderDto, @Req() r: any) { return this.s.create(d, r.user.id); }
  @Get(':id') get(@Param('id') id: string, @Req() req: any) { return this.s.get(id, req.user.id); }
  @Patch(':id') @Permissions('reminders:write') update(@Param('id') id: string, @Body() d: UpdateReminderDto, @Req() req: any) { return this.s.update(id, d, req.user.id); }
  @Patch(':id/status') @Permissions('reminders:write') status(@Param('id') id: string, @Body() dto: ReminderStatusDto, @Req() req: any) { return this.s.status(id, dto.status, req.user.id); }

  @Get(':id/comments') comments(@Param('id') id: string, @Req() req: any) { return this.s.listComments(id, req.user.id); }
  @Post(':id/comments') addComment(@Param('id') id: string, @Body() dto: ReminderCommentDto, @Req() req: any) { return this.s.addComment(id, req.user.id, dto.body); }
  @Get(':id/attachments') @Header('Cache-Control', 'private, no-store') attachments(@Param('id') id: string, @Req() req: any) { return this.s.listAttachments(id, req.user.id); }
  @Post(':id/attachments')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(FileInterceptor('file', attachmentMulterOptions))
  addAttachment(@Param('id') id: string, @Req() req: any, @UploadedFile() file: UploadedAttachmentFile | undefined) {
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
    sendAttachment(response, attachment);
  }

  @Delete(':id') @Permissions('reminders:write') remove(@Param('id') id: string, @Req() req: any) { return this.s.remove(id, req.user.id); }
}

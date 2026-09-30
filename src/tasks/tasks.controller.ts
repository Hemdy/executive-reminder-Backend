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
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { TaskCommentDto, TaskDto, TaskStatusDto, UpdateTaskDto } from './task.dto';
import { TasksService } from './tasks.service';

const allowedAttachmentTypes = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/plain'
]);

interface UploadedTaskFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  @Permissions('tasks:read')
  list(@Req() req: any) {
    return this.service.list(req.user.id);
  }

  @Post()
  @Permissions('tasks:write')
  create(@Body() dto: TaskDto, @Req() req: any) {
    return this.service.create(dto, req.user.id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  @Permissions('tasks:write')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  status(@Param('id') id: string, @Body() dto: TaskStatusDto, @Req() req: any) {
    return this.service.status(id, dto.status, req.user.id);
  }

  @Get(':id/comments')
  comments(@Param('id') id: string, @Req() req: any) {
    return this.service.listComments(id, req.user.id);
  }

  @Post(':id/comments')
  addComment(@Param('id') id: string, @Body() dto: TaskCommentDto, @Req() req: any) {
    return this.service.addComment(id, req.user.id, dto.body);
  }

  @Get(':id/attachments')
  attachments(@Param('id') id: string, @Req() req: any) {
    return this.service.listAttachments(id, req.user.id);
  }

  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (_request, file, callback) => {
      if (!allowedAttachmentTypes.has(file.mimetype)) {
        callback(new BadRequestException('Unsupported file type'), false);
        return;
      }
      callback(null, true);
    }
  }))
  addAttachment(
    @Param('id') id: string,
    @Req() req: any,
    @UploadedFile() file: UploadedTaskFile | undefined
  ) {
    if (!file) {
      throw new BadRequestException('Choose a supported attachment to upload');
    }
    return this.service.addAttachment(id, req.user.id, file);
  }

  @Get(':id/attachments/:attachmentId')
  async downloadAttachment(
    @Param('id') taskId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
    @Res() response: Response
  ) {
    const attachment = await this.service.getAttachment(taskId, attachmentId, req.user.id);
    const asciiFileName = attachment.fileName
      .replace(/[\r\n"]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`
    );
    response.setHeader('Content-Type', attachment.mimeType);
    response.setHeader('Content-Length', attachment.size);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(Buffer.from(attachment.content));
  }

  @Delete(':id')
  @Permissions('tasks:write')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}

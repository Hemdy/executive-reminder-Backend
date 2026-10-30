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
  UseInterceptors
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
import { TaskCommentDto, TaskDto, TaskStatusDto, UpdateTaskDto } from './task.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.list(req.user.id);
  }

  @Post()
  @Permissions('tasks:write')
  create(@Body() dto: TaskDto, @Req() req: any) {
    return this.service.create(dto, req.user.id);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: any) {
    return this.service.get(id, req.user.id);
  }

  @Patch(':id')
  @Permissions('tasks:write')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.id);
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
  @Header('Cache-Control', 'private, no-store')
  attachments(@Param('id') id: string, @Req() req: any) {
    return this.service.listAttachments(id, req.user.id);
  }

  @Post(':id/attachments')
  @Header('Cache-Control', 'private, no-store')
  @UseInterceptors(FileInterceptor('file', attachmentMulterOptions))
  addAttachment(
    @Param('id') id: string,
    @Req() req: any,
    @UploadedFile() file: UploadedAttachmentFile | undefined
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
    sendAttachment(response, attachment);
  }

  @Delete(':id')
  @Permissions('tasks:write')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.service.remove(id, req.user.id);
  }
}

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
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Priority, RequestStatus, RequestType } from '@prisma/client';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname } from 'node:path';
import type { Response } from 'express';
import { sendAttachment } from '../common/attachment-response';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';
import { RequestsService } from './requests.service';

class RequestDto {
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(RequestType) type!: RequestType;
  @IsEnum(Priority) priority!: Priority;
  @IsString() assignedToId!: string;
  @IsOptional() @IsDateString() dueDate?: string;
}

class UpdateRequestDto extends RequestDto {
  @IsEnum(RequestStatus) status!: RequestStatus;
}

class RequestStatusDto {
  @IsEnum(RequestStatus) status!: RequestStatus;
}

class RequestCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}

const allowedAttachmentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

interface UploadedRequestFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Controller('requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RequestsController {
  constructor(private readonly s: RequestsService) {}

  @Get() @Permissions('requests:read') list(@Req() r: any) { return this.s.list(r.user.id); }
  @Post() @Permissions('requests:write') create(@Body() d: RequestDto, @Req() r: any) { return this.s.create(d, r.user.id); }
  @Get(':id') get(@Param('id') id: string, @Req() req: any) { return this.s.get(id, req.user.id); }
  @Patch(':id') @Permissions('requests:write') update(@Param('id') id: string, @Body() d: UpdateRequestDto, @Req() req: any) { return this.s.update(id, d, req.user.id); }
  @Patch(':id/status') @Permissions('requests:write') status(@Param('id') id: string, @Body() dto: RequestStatusDto, @Req() req: any) { return this.s.status(id, dto.status, req.user.id); }

  @Get(':id/comments') comments(@Param('id') id: string, @Req() req: any) { return this.s.listComments(id, req.user.id); }
  @Post(':id/comments') addComment(@Param('id') id: string, @Body() dto: RequestCommentDto, @Req() req: any) { return this.s.addComment(id, req.user.id, dto.body); }
  @Get(':id/attachments') @Header('Cache-Control', 'private, no-store') attachments(@Param('id') id: string, @Req() req: any) { return this.s.listAttachments(id, req.user.id); }
  @Post(':id/attachments')
  @Header('Cache-Control', 'private, no-store')
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
  addAttachment(@Param('id') id: string, @Req() req: any, @UploadedFile() file: UploadedRequestFile | undefined) {
    if (!file) {
      throw new BadRequestException('Choose a supported attachment to upload');
    }
    return this.s.addAttachment(id, req.user.id, file);
  }

  @Get(':id/attachments/:attachmentId')
  async downloadAttachment(
    @Param('id') requestId: string,
    @Param('attachmentId') attachmentId: string,
    @Req() req: any,
    @Res() response: Response,
  ) {
    const attachment = await this.s.getAttachment(requestId, attachmentId, req.user.id);
    sendAttachment(response, attachment);
  }

  @Delete(':id') @Permissions('requests:write') remove(@Param('id') id: string, @Req() req: any) { return this.s.remove(id, req.user.id); }
}

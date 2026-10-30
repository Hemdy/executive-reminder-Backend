import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Response } from 'express';
import { extname } from 'node:path';

export const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024; // 4 MB

export const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['.pdf', { mimeType: 'application/pdf', signature: Buffer.from('%PDF-') }],
  [
    '.doc',
    {
      mimeType: 'application/msword',
      signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    },
  ],
  [
    '.docx',
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      signature: Buffer.from('PK'),
    },
  ],
]);

export interface UploadedAttachmentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const attachmentMulterOptions: MulterOptions = {
  limits: { fileSize: MAX_ATTACHMENT_SIZE },
  fileFilter: (_request, file, callback) => {
    const extension = extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_TYPES.has(extension)) {
      callback(new BadRequestException('Only PDF and Word documents are supported'), false);
      return;
    }
    callback(null, true);
  },
};

export interface DownloadableAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

export function sendAttachment(response: Response, attachment: DownloadableAttachment): void {
  if (attachment.content.byteLength !== attachment.size) {
    throw new BadGatewayException('Stored attachment size does not match its metadata');
  }

  const safeName = attachment.fileName.replace(/[\r\n"]/g, '_');
  const asciiFileName = safeName.replace(/[^\x20-\x7e]/g, '_');
  const encodedFileName = encodeURIComponent(attachment.fileName).replace(
    /['()*!]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  response.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
  );
  response.setHeader('Content-Type', attachment.mimeType);
  response.setHeader('Content-Length', attachment.content.byteLength);
  response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.vary('Authorization');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.send(attachment.content);
}

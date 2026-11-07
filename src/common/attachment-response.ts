import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import type { Response } from 'express';
import { extname } from 'node:path';

export const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024; // 4 MB

interface AttachmentFileType {
  mimeType: string;
  mimeTypes: string[];
  signature?: Buffer;
}

export const ALLOWED_ATTACHMENT_TYPES = new Map<string, AttachmentFileType>([
  ['.pdf', { mimeType: 'application/pdf', mimeTypes: ['application/pdf'], signature: Buffer.from('%PDF-') }],
  [
    '.doc',
    {
      mimeType: 'application/msword',
      mimeTypes: ['application/msword'],
      signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    },
  ],
  [
    '.docx',
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      signature: Buffer.from('PK'),
    },
  ],
]);

export const TASK_ALLOWED_ATTACHMENT_TYPES = new Map<string, AttachmentFileType>([
  ...ALLOWED_ATTACHMENT_TYPES,
  [
    '.xls',
    {
      mimeType: 'application/vnd.ms-excel',
      mimeTypes: ['application/vnd.ms-excel', 'application/x-msexcel'],
      signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    },
  ],
  [
    '.xlsx',
    {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      signature: Buffer.from('PK'),
    },
  ],
  [
    '.csv',
    {
      mimeType: 'text/csv',
      mimeTypes: ['text/csv', 'application/csv', 'application/vnd.ms-excel'],
    },
  ],
  ['.jpg', { mimeType: 'image/jpeg', mimeTypes: ['image/jpeg', 'image/pjpeg'], signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['.jpeg', { mimeType: 'image/jpeg', mimeTypes: ['image/jpeg', 'image/pjpeg'], signature: Buffer.from([0xff, 0xd8, 0xff]) }],
  ['.png', { mimeType: 'image/png', mimeTypes: ['image/png'], signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
  ['.gif', { mimeType: 'image/gif', mimeTypes: ['image/gif'], signature: Buffer.from('GIF8') }],
  ['.webp', { mimeType: 'image/webp', mimeTypes: ['image/webp'], signature: Buffer.from('RIFF') }],
  ['.svg', { mimeType: 'image/svg+xml', mimeTypes: ['image/svg+xml', 'text/xml', 'application/xml'] }],
]);

export interface UploadedAttachmentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function createAttachmentMulterOptions(
  allowedTypes: Map<string, AttachmentFileType>,
  supportedMessage: string,
): MulterOptions {
  return {
    limits: { fileSize: MAX_ATTACHMENT_SIZE },
    fileFilter: (_request, file, callback) => {
      const extension = extname(file.originalname || '').toLowerCase();
      const fileType = allowedTypes.get(extension);
      const mimeType = (file.mimetype || '').toLowerCase();
      if (
        !fileType ||
        (mimeType && mimeType !== 'application/octet-stream' && !fileType.mimeTypes.includes(mimeType))
      ) {
        callback(new BadRequestException(supportedMessage), false);
        return;
      }
      callback(null, true);
    },
  };
}

export const attachmentMulterOptions = createAttachmentMulterOptions(
  ALLOWED_ATTACHMENT_TYPES,
  'Only PDF and Word documents are supported',
);

export const taskAttachmentMulterOptions = createAttachmentMulterOptions(
  TASK_ALLOWED_ATTACHMENT_TYPES,
  'This task attachment type is not supported',
);

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

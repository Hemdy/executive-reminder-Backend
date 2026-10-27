import { BadGatewayException } from '@nestjs/common';
import type { Response } from 'express';

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
  response.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.setHeader('Vary', 'Authorization');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.send(attachment.content);
}

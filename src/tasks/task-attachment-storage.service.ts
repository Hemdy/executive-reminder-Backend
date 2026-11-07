import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  ALLOWED_ATTACHMENT_TYPES,
  DownloadableAttachment,
  MAX_ATTACHMENT_SIZE,
  TASK_ALLOWED_ATTACHMENT_TYPES,
  UploadedAttachmentFile,
} from '../common/attachment-response';

export type AttachmentModuleScope = 'tasks' | 'reminders' | 'meetings' | 'requests';

export interface PreparedAttachmentPayload {
  fileName: string;
  mimeType: string;
  size: number;
  storagePath: string | null;
  inlineContent: ReturnType<Uint8Array['slice']> | null;
}

export class MissingAttachmentObjectError extends BadGatewayException {
  constructor() {
    super('Attachment file is missing from storage');
  }
}

type StorageConfiguration =
  | {
      provider: 'supabase';
      baseUrl: string;
      serviceRoleKey: string;
      bucket: string;
    }
  | {
      provider: 'local';
      directory: string;
    }
  | {
      provider: 'database';
    };

@Injectable()
export class TaskAttachmentStorageService {
  private readonly logger = new Logger(TaskAttachmentStorageService.name);
  private ensuredBucket: string | null = null;

  async prepareAndUpload(
    scope: AttachmentModuleScope,
    entityId: string,
    file: UploadedAttachmentFile,
  ): Promise<PreparedAttachmentPayload> {
    if (!file?.buffer || file.buffer.byteLength === 0) {
      throw new BadRequestException('Attachment file is empty');
    }
    if (file.buffer.byteLength > MAX_ATTACHMENT_SIZE || file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException('Attachments must be 4 MB or smaller');
    }

    const decodedOriginalName = this.decodeOriginalFilename(file.originalname);
    const fileName = decodedOriginalName
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/[\u0000-\u001f\u007f]/g, '_')
      .trim()
      .slice(0, 255);

    if (!fileName || fileName === '.' || fileName === '..') {
      throw new BadRequestException('Attachment filename is invalid');
    }

    const extension = extname(fileName).toLowerCase();
    const allowedTypes = scope === 'tasks' ? TASK_ALLOWED_ATTACHMENT_TYPES : ALLOWED_ATTACHMENT_TYPES;
    const fileType = allowedTypes.get(extension);
    if (!fileType) {
      throw new BadRequestException(
        scope === 'tasks'
          ? 'This task attachment type is not supported'
          : 'Only valid PDF and Word documents are supported',
      );
    }

    const mimeType = (file.mimetype || '').toLowerCase();
    if (
      mimeType &&
      mimeType !== 'application/octet-stream' &&
      !fileType.mimeTypes.includes(mimeType)
    ) {
      throw new BadRequestException('The uploaded file MIME type does not match its extension');
    }

    if (!this.hasValidFileSignature(extension, file.buffer, allowedTypes)) {
      throw new BadRequestException('The uploaded file content does not match its file type');
    }

    const objectPath = `${scope}/${entityId}/${randomUUID()}${extension}`;
    const stored = await this.uploadWithFallback(objectPath, file.buffer, fileType.mimeType);

    return {
      fileName,
      mimeType: fileType.mimeType,
      size: file.buffer.byteLength,
      storagePath: stored.storagePath,
      inlineContent: stored.inlineContent,
    };
  }

  async resolveContent(
    attachment: {
      fileName: string;
      mimeType: string;
      size: number;
      storagePath: string | null;
      legacyContent: Uint8Array | Buffer | null;
    },
    label: string,
  ): Promise<DownloadableAttachment> {
    if (attachment.storagePath) {
      try {
        const content = await this.download(attachment.storagePath);
        return {
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          content,
        };
      } catch (error) {
        if (attachment.legacyContent) {
          this.logger.warn(
            `Object storage download failed for ${attachment.storagePath}; serving inline PostgreSQL content fallback`,
          );
          return {
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            content: Buffer.from(attachment.legacyContent),
          };
        }
        throw error;
      }
    }

    if (attachment.legacyContent) {
      return {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        content: Buffer.from(attachment.legacyContent),
      };
    }

    throw new BadGatewayException(`${label} attachment is missing its stored file`);
  }

  async upload(path: string, content: Buffer, contentType: string): Promise<void> {
    const config = this.configuration();
    if (config.provider === 'database') {
      return;
    }
    if (config.provider === 'local') {
      const filePath = this.localPath(config, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, { flag: 'wx' });
      return;
    }

    await this.uploadToSupabase(config, path, content, contentType);
  }

  async download(path: string): Promise<Buffer> {
    const config = this.configuration();
    if (config.provider === 'supabase') {
      const response = await fetch(this.objectUrl(config, path), {
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new MissingAttachmentObjectError();
        }
        throw new BadGatewayException(
          `Attachment storage could not provide the file (${response.status})`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    }

    const localDir = resolve(process.env.TASK_ATTACHMENTS_LOCAL_DIR ?? '.task-attachments');
    try {
      return await readFile(this.localPath({ provider: 'local', directory: localDir }, path));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new MissingAttachmentObjectError();
      }
      throw error;
    }
  }

  async remove(path: string | null): Promise<void> {
    if (!path) {
      return;
    }
    const config = this.configuration();
    if (config.provider === 'database') {
      throw new BadGatewayException(
        'External attachment storage is not configured for this stored file',
      );
    }
    if (config.provider === 'local') {
      try {
        await unlink(this.localPath(config, path));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      return;
    }

    const response = await fetch(
      `${config.baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: [path] }),
      },
    );

    if (!response.ok) {
      if (response.status === 404) {
        return;
      }
      throw new BadGatewayException(
        `Attachment storage could not remove the uploaded file (${response.status})`,
      );
    }
  }

  private async uploadWithFallback(
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<{ storagePath: string | null; inlineContent: ReturnType<Uint8Array['slice']> | null }> {
    const config = this.configuration();

    if (config.provider === 'supabase') {
      try {
        await this.uploadToSupabase(config, path, content, contentType);
        return { storagePath: path, inlineContent: null };
      } catch (error) {
        this.logger.warn(
          `Supabase Storage upload failed (${error instanceof Error ? error.message : 'unknown error'}); falling back to PostgreSQL bytea storage`,
        );
        return { storagePath: null, inlineContent: Uint8Array.from(content) };
      }
    }

    if (config.provider === 'local') {
      const filePath = this.localPath(config, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, { flag: 'wx' });
      return { storagePath: path, inlineContent: null };
    }

    // Default durable serverless-safe tier: store directly in PostgreSQL bytea column.
    return { storagePath: null, inlineContent: Uint8Array.from(content) };
  }

  private async uploadToSupabase(
    config: Extract<StorageConfiguration, { provider: 'supabase' }>,
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<void> {
    let response = await this.putSupabaseObject(config, path, content, contentType);

    // Auto-create private bucket on first upload if missing
    if (!response.ok && (response.status === 400 || response.status === 404) && this.ensuredBucket !== config.bucket) {
      await this.ensureSupabaseBucket(config);
      response = await this.putSupabaseObject(config, path, content, contentType);
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `Supabase Storage rejected the upload (${response.status})`,
      );
    }
  }

  private putSupabaseObject(
    config: Extract<StorageConfiguration, { provider: 'supabase' }>,
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<Response> {
    return fetch(this.objectUrl(config, path), {
      method: 'POST',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': contentType,
        'x-upsert': 'false',
      },
      body: Uint8Array.from(content),
    });
  }

  private async ensureSupabaseBucket(
    config: Extract<StorageConfiguration, { provider: 'supabase' }>,
  ): Promise<void> {
    this.ensuredBucket = config.bucket;
    try {
      await fetch(`${config.baseUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: config.bucket,
          name: config.bucket,
          public: false,
          file_size_limit: MAX_ATTACHMENT_SIZE,
        }),
      });
    } catch {
      // Ignore bucket creation error; retry upload will surface any real failure
    }
  }

  private configuration(): StorageConfiguration {
    const clean = (value?: string) => (value ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
    const baseUrl = clean(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const serviceRoleKey = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const bucket = clean(process.env.SUPABASE_STORAGE_BUCKET) || 'task-attachments';

    if (baseUrl && serviceRoleKey) {
      return { provider: 'supabase', baseUrl, serviceRoleKey, bucket };
    }

    const explicitLocalDir = clean(process.env.TASK_ATTACHMENTS_LOCAL_DIR);
    if (explicitLocalDir && process.env.NODE_ENV !== 'production') {
      return {
        provider: 'local',
        directory: resolve(explicitLocalDir),
      };
    }

    return { provider: 'database' };
  }

  private hasValidFileSignature(
    extension: string,
    content: Buffer,
    allowedTypes: Map<string, { mimeType: string; mimeTypes: string[]; signature?: Buffer }>,
  ): boolean {
    const type = allowedTypes.get(extension);
    if (!type) {
      return false;
    }

    if (extension === '.pdf') {
      // ISO 32000-1 permits the %PDF- header anywhere within the first 1024 bytes.
      const signature = type.signature;
      return Boolean(signature && content.subarray(0, 1024).includes(signature));
    }

    if (extension === '.csv') {
      return this.isTextFile(content);
    }

    if (extension === '.svg') {
      return this.isSafeSvg(content);
    }

    if (!type.signature || !content.subarray(0, type.signature.length).equals(type.signature)) {
      return false;
    }

    if (extension === '.webp') {
      return content.length >= 12 && content.toString('ascii', 8, 12) === 'WEBP';
    }
    if (extension === '.gif') {
      return content.length >= 6 &&
        ['GIF87a', 'GIF89a'].includes(content.toString('ascii', 0, 6));
    }
    if (extension !== '.docx' && extension !== '.xlsx') {
      return true;
    }

    return extension === '.docx'
      ? this.hasZipEntries(content, ['[Content_Types].xml', 'word/document.xml'])
      : this.hasZipEntries(content, ['[Content_Types].xml', 'xl/workbook.xml']);
  }

  private hasZipEntries(content: Buffer, requiredEntries: string[]): boolean {
    const endOfDirectorySignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const directorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
    const endOffset = content.lastIndexOf(endOfDirectorySignature);
    if (endOffset < 0 || endOffset + 22 > content.length) {
      return false;
    }

    const commentLength = content.readUInt16LE(endOffset + 20);
    const directoryEntries = content.readUInt16LE(endOffset + 10);
    const directorySize = content.readUInt32LE(endOffset + 12);
    const directoryOffset = content.readUInt32LE(endOffset + 16);
    const directoryEnd = directoryOffset + directorySize;
    if (
      endOffset + 22 + commentLength !== content.length ||
      directoryEnd > endOffset ||
      directoryEntries === 0
    ) {
      return false;
    }

    const entries = new Set<string>();
    let cursor = directoryOffset;
    for (let index = 0; index < directoryEntries; index += 1) {
      if (
        cursor + 46 > directoryEnd ||
        !content.subarray(cursor, cursor + 4).equals(directorySignature)
      ) {
        return false;
      }
      const nameLength = content.readUInt16LE(cursor + 28);
      const extraLength = content.readUInt16LE(cursor + 30);
      const entryCommentLength = content.readUInt16LE(cursor + 32);
      const entryEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (entryEnd > directoryEnd) {
        return false;
      }
      entries.add(content.toString('utf8', cursor + 46, cursor + 46 + nameLength));
      cursor = entryEnd;
    }

    return cursor === directoryEnd && requiredEntries.every(entry => entries.has(entry));
  }

  private isTextFile(content: Buffer): boolean {
    if (content.includes(0)) {
      return false;
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      return !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
    } catch (error) {
      if (error instanceof TypeError) {
        return false;
      }
      throw error;
    }
  }

  private isSafeSvg(content: Buffer): boolean {
    let markup: string;
    try {
      markup = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch (error) {
      if (error instanceof TypeError) {
        return false;
      }
      throw error;
    }
    return /<svg(?:\s|>)/i.test(markup) &&
      !/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\bon[a-z]+\s*=|javascript\s*:|@import|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)|url\s*\(/i.test(markup);
  }

  private decodeOriginalFilename(rawName: string): string {
    if (!rawName) {
      return '';
    }
    // Busboy/Multer parses non-ASCII multipart headers as latin1; decode back to UTF-8 if valid
    if (/[\u0080-\u00ff]/.test(rawName)) {
      try {
        const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
        if (!decoded.includes('\ufffd')) {
          return decoded;
        }
      } catch {
        // Keep original string
      }
    }
    return rawName;
  }

  private objectUrl(
    config: Extract<StorageConfiguration, { provider: 'supabase' }>,
    path: string,
  ): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `${config.baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodedPath}`;
  }

  private localPath(
    config: Extract<StorageConfiguration, { provider: 'local' }>,
    objectPath: string,
  ): string {
    const root = resolve(config.directory);
    const filePath = resolve(root, ...objectPath.split('/'));
    const pathFromRoot = relative(root, filePath);
    if (
      !pathFromRoot ||
      isAbsolute(pathFromRoot) ||
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === '..'
    ) {
      throw new BadRequestException('Invalid attachment storage path');
    }
    return filePath;
  }
}

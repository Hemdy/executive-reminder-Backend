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
    const fileType = ALLOWED_ATTACHMENT_TYPES.get(extension);
    if (!fileType) {
      throw new BadRequestException('Only valid PDF and Word documents are supported');
    }

    if (!this.hasValidFileSignature(extension, file.buffer)) {
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
        throw new BadGatewayException('Attachment file is missing from storage');
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
      return;
    }
    if (config.provider === 'local') {
      await unlink(this.localPath(config, path)).catch(() => undefined);
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

  private hasValidFileSignature(extension: string, content: Buffer): boolean {
    const type = ALLOWED_ATTACHMENT_TYPES.get(extension);
    if (!type) {
      return false;
    }

    if (extension === '.pdf') {
      // ISO 32000-1 permits the %PDF- header anywhere within the first 1024 bytes.
      return content.subarray(0, 1024).includes(type.signature);
    }

    if (!content.subarray(0, type.signature.length).equals(type.signature)) {
      return false;
    }

    if (extension !== '.docx') {
      return true;
    }

    const archiveNames = content.toString('latin1');
    return archiveNames.includes('[Content_Types].xml') && archiveNames.includes('word/');
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

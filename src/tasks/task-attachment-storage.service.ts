import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type StorageConfiguration = {
  provider: 'supabase';
  baseUrl: string;
  serviceRoleKey: string;
  bucket: string;
} | {
  provider: 'local';
  directory: string;
};

@Injectable()
export class TaskAttachmentStorageService {
  async upload(path: string, content: Buffer, contentType: string): Promise<void> {
    const config = this.configuration();
    if (config.provider === 'local') {
      const filePath = this.localPath(config, path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, { flag: 'wx' });
      return;
    }

    const response = await fetch(this.objectUrl(config, path), {
      method: 'POST',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': contentType,
        'x-upsert': 'false'
      },
      body: Uint8Array.from(content)
    });

    if (!response.ok) {
      throw new BadGatewayException(`Task attachment storage rejected the upload (${response.status})`);
    }
  }

  async download(path: string): Promise<Buffer> {
    const config = this.configuration();
    if (config.provider === 'local') {
      try {
        return await readFile(this.localPath(config, path));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          throw new BadGatewayException('Task attachment file is missing from local storage');
        }
        throw error;
      }
    }

    const response = await fetch(this.objectUrl(config, path), {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`
      }
    });

    if (!response.ok) {
      throw new BadGatewayException(`Task attachment storage could not provide the file (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(path: string): Promise<void> {
    const config = this.configuration();
    if (config.provider === 'local') {
      await unlink(this.localPath(config, path));
      return;
    }

    const response = await fetch(
      `${config.baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}`,
      {
      method: 'DELETE',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prefixes: [path] })
      }
    );

    if (!response.ok) {
      throw new BadGatewayException(`Task attachment storage could not remove the uploaded file (${response.status})`);
    }
  }

  private configuration(): StorageConfiguration {
    const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'task-attachments';
    if (baseUrl && serviceRoleKey) {
      return { provider: 'supabase', baseUrl, serviceRoleKey, bucket };
    }
    if (baseUrl || serviceRoleKey || process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Configure Supabase Storage for task attachments on the backend'
      );
    }
    return {
      provider: 'local',
      directory: resolve(process.env.TASK_ATTACHMENTS_LOCAL_DIR ?? '.task-attachments')
    };
  }

  private objectUrl(
    config: Extract<StorageConfiguration, { provider: 'supabase' }>,
    path: string
  ): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `${config.baseUrl}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodedPath}`;
  }

  private localPath(
    config: Extract<StorageConfiguration, { provider: 'local' }>,
    objectPath: string
  ): string {
    const root = resolve(config.directory);
    const filePath = resolve(root, ...objectPath.split('/'));
    const pathFromRoot = relative(root, filePath);
    if (!pathFromRoot || isAbsolute(pathFromRoot) || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..') {
      throw new BadRequestException('Invalid task attachment storage path');
    }
    return filePath;
  }
}

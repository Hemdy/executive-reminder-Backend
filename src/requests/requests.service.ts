import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskAttachmentStorageService } from '../tasks/task-attachment-storage.service';

const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const ATTACHMENT_TYPES = new Map([
  ['.pdf', { mimeType: 'application/pdf', signature: Buffer.from('%PDF-') }],
  ['.doc', { mimeType: 'application/msword', signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }],
  ['.docx', {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: Buffer.from('PK')
  }],
]);

@Injectable()
export class RequestsService {
  constructor(
    private readonly db: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly attachmentStorage: TaskAttachmentStorageService,
  ) {}

  private readonly userSelect = {
    id: true,
    title: true,
    firstName: true,
    middleName: true,
    lastName: true,
    email: true,
    role: true,
    roleId: true,
    department: true,
    avatarUrl: true,
    isActive: true,
  } as const;

  private readonly requestInclude = {
    requester: { select: this.userSelect },
    assignedTo: { select: this.userSelect },
    _count: { select: { comments: true, attachments: true } },
  } as const;

  list(id: string) {
    return this.db.request.findMany({
      where: { OR: [{ requesterId: id }, { assignedToId: id }] },
      include: this.requestInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(d: any, id: string) {
    const request = await this.db.request.create({
      data: { ...d, dueDate: d.dueDate ? new Date(d.dueDate) : undefined, requesterId: id },
      include: this.requestInclude,
    });
    await this.notifications.createForUsers(
      {
        title: 'New request submitted',
        message: `${request.requester.firstName} ${request.requester.lastName} submitted "${request.title}" for your review.`,
        type: 'REQUEST',
        priority: request.priority,
        sourceId: request.id,
        referenceId: request.id,
        resourceType: 'request',
        route: `/requests/${request.id}`,
      },
      [request.assignedToId].filter(recipientId => recipientId !== id),
      `request_created:${request.id}`,
    );
    return request;
  }

  async get(id: string, userId: string) {
    const request = await this.db.request.findUnique({
      where: { id },
      include: this.requestInclude,
    });
    if (!request) {
      throw new NotFoundException('Request not found');
    }
    const canAccess = request.requesterId === userId || request.assignedToId === userId;
    if (!canAccess) {
      throw new ForbiddenException('You are not allowed to access this request');
    }
    return request;
  }

  async update(id: string, d: any, actorId: string) {
    const existing = await this.db.request.findUniqueOrThrow({
      where: { id },
      select: {
        title: true,
        description: true,
        type: true,
        priority: true,
        dueDate: true,
        status: true,
        requesterId: true,
        assignedToId: true,
      },
    });
    const request = await this.db.request.update({
      where: { id },
      data: { ...d, dueDate: d.dueDate ? new Date(d.dueDate) : undefined },
      include: this.requestInclude,
    });
    const changed =
      request.title !== existing.title ||
      request.description !== existing.description ||
      request.type !== existing.type ||
      request.priority !== existing.priority ||
      request.status !== existing.status ||
      request.assignedToId !== existing.assignedToId ||
      (request.dueDate?.getTime() ?? null) !== (existing.dueDate?.getTime() ?? null);
    if (changed) {
      await this.notifications.suppressPendingPushNotifications('request', request.id);
      await this.notifications.createForUsers(
        {
          title: request.status === 'APPROVED'
            ? 'Request approved'
            : request.status === 'REJECTED'
              ? 'Request rejected'
              : request.status === 'CANCELLED'
                ? 'Request cancelled'
              : request.status === 'NEEDS_INFORMATION'
                ? 'Additional information requested'
                : request.status !== existing.status
                  ? 'Request status updated'
                  : 'Request updated',
          message: request.status !== existing.status
            ? `"${request.title}" is now ${request.status.replaceAll('_', ' ').toLowerCase()}.`
            : `"${request.title}" has been updated.`,
          type: 'REQUEST',
          priority: request.priority,
          sourceId: request.id,
          referenceId: request.id,
          resourceType: 'request',
          route: `/requests/${request.id}`,
        },
        [request.requesterId, request.assignedToId]
          .filter(recipientId => recipientId !== actorId),
        `request_updated:${request.id}:${request.updatedAt.toISOString()}`,
      );
    }
    return request;
  }

  async remove(id: string, actorId: string) {
    const request = await this.db.request.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        title: true,
        priority: true,
        createdAt: true,
        requesterId: true,
        assignedToId: true,
      },
    });
    await this.notifications.suppressPendingPushNotifications('request', request.id);
    await this.notifications.createForUsers(
      {
        title: 'Request deleted',
        message: `"${request.title}" was deleted.`,
        type: 'REQUEST',
        priority: request.priority,
        sourceId: request.id,
        referenceId: request.id,
        resourceType: 'request',
        route: '/requests',
      },
      [request.requesterId, request.assignedToId].filter(recipientId => recipientId !== actorId),
      `request_deleted:${request.id}:${request.createdAt.toISOString()}`,
    );
    return this.db.request.delete({ where: { id } });
  }

  async status(id: string, status: string, actorId: string) {
    const existing = await this.db.request.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    const request = await this.db.request.update({
      where: { id },
      data: { status: status as never },
      include: this.requestInclude,
    });
    if (existing.status !== request.status) {
      await this.notifications.suppressPendingPushNotifications('request', request.id);
      await this.notifications.createForUsers(
        {
          title: request.status === 'APPROVED'
            ? 'Request approved'
            : request.status === 'REJECTED'
              ? 'Request rejected'
              : request.status === 'CANCELLED'
                ? 'Request cancelled'
              : request.status === 'NEEDS_INFORMATION'
                ? 'Additional information requested'
                : 'Request status updated',
          message: `"${request.title}" is now ${request.status.replaceAll('_', ' ').toLowerCase()}.`,
          type: 'REQUEST',
          priority: request.priority,
          sourceId: request.id,
          referenceId: request.id,
          resourceType: 'request',
          route: `/requests/${request.id}`,
        },
        [request.requesterId, request.assignedToId].filter(recipientId => recipientId !== actorId),
        `request_status:${request.id}:${request.updatedAt.toISOString()}`,
      );
    }
    return request;
  }

  async listComments(requestId: string, userId: string) {
    await this.ensureRequestAccess(requestId, userId);
    return this.db.requestComment.findMany({
      where: { requestId },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(requestId: string, userId: string, body: string) {
    await this.ensureRequestAccess(requestId, userId);
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const comment = await this.db.requestComment.create({
      data: { requestId, authorId: userId, body: trimmedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
    });
    const request = await this.db.request.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        title: true,
        requesterId: true,
        assignedToId: true,
      },
    });
    const recipients = [request.requesterId, request.assignedToId].filter(id => id !== userId);
    await this.notifications.createForUsers(
      {
        title: 'New request comment',
        message: `${comment.author.firstName} ${comment.author.lastName} commented on "${request.title}".`,
        type: 'COMMENT',
        priority: 'MEDIUM',
        sourceId: requestId,
        referenceId: requestId,
        resourceType: 'request',
        route: `/requests/${requestId}?comment=${comment.id}`,
      },
      recipients,
      `request_comment:${comment.id}`,
    );
    return comment;
  }

  async listAttachments(requestId: string, userId: string) {
    await this.ensureRequestAccess(requestId, userId);
    return this.db.requestAttachment.findMany({
      where: { requestId },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        size: true,
        createdAt: true,
        uploader: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addAttachment(requestId: string, userId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    await this.ensureRequestAccess(requestId, userId);
    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException('Attachments must be 4 MB or smaller');
    }
    const fileName = file.originalname
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/[\u0000-\u001f\u007f]/g, '_')
      .slice(0, 255);
    if (!fileName || fileName === '.' || fileName === '..') {
      throw new BadRequestException('Attachment filename is invalid');
    }

    const extension = extname(fileName).toLowerCase();
    const fileType = ATTACHMENT_TYPES.get(extension);
    if (!fileType || (file.mimetype !== fileType.mimeType && file.mimetype !== 'application/octet-stream')) {
      throw new BadRequestException('Only valid PDF and Word documents are supported');
    }
    if (!this.hasValidFileSignature(extension, file.buffer)) {
      throw new BadRequestException('The uploaded file content does not match its file type');
    }

    const storagePath = `${requestId}/${randomUUID()}${extension}`;
    await this.attachmentStorage.upload(storagePath, file.buffer, fileType.mimeType);
    try {
      return await this.db.requestAttachment.create({
        data: {
          requestId,
          uploaderId: userId,
          fileName,
          mimeType: fileType.mimeType,
          size: file.size,
          storagePath,
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          size: true,
          createdAt: true,
          uploader: { select: { id: true, firstName: true, lastName: true } },
        },
      });
    } catch (error) {
      try {
        await this.attachmentStorage.remove(storagePath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Unable to save request attachment metadata or clean up its stored object');
      }
      throw error;
    }
  }

  async getAttachment(requestId: string, attachmentId: string, userId: string) {
    await this.ensureRequestAccess(requestId, userId);
    const attachment = await this.db.requestAttachment.findFirst({
      where: { id: attachmentId, requestId },
      select: {
        fileName: true,
        mimeType: true,
        size: true,
        storagePath: true,
        legacyContent: true,
      },
    });
    if (!attachment) {
      throw new NotFoundException('Request attachment not found');
    }
    if (attachment.storagePath) {
      return { ...attachment, content: await this.attachmentStorage.download(attachment.storagePath) };
    }
    if (attachment.legacyContent) {
      return { ...attachment, content: Buffer.from(attachment.legacyContent) };
    }
    throw new BadGatewayException('Request attachment is missing its stored file');
  }

  private hasValidFileSignature(extension: string, content: Buffer): boolean {
    const type = ATTACHMENT_TYPES.get(extension);
    if (!type || !content.subarray(0, type.signature.length).equals(type.signature)) {
      return false;
    }
    if (extension !== '.docx') {
      return true;
    }
    const archiveNames = content.toString('latin1');
    return archiveNames.includes('[Content_Types].xml') && archiveNames.includes('word/document.xml');
  }

  private async ensureRequestAccess(requestId: string, userId: string): Promise<void> {
    const request = await this.db.request.findUnique({
      where: { id: requestId },
      select: { requesterId: true, assignedToId: true },
    });
    if (!request) {
      throw new NotFoundException('Request not found');
    }
    const canAccess = request.requesterId === userId || request.assignedToId === userId;
    if (!canAccess) {
      throw new ForbiddenException('You are not allowed to access this request');
    }
  }
}

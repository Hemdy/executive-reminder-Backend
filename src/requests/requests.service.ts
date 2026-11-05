import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UploadedAttachmentFile } from '../common/attachment-response';
import { hasActivityWritePermission } from '../common/activity-access';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  MissingAttachmentObjectError,
  TaskAttachmentStorageService,
} from '../tasks/task-attachment-storage.service';

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
    if (existing.requesterId !== actorId) {
      throw new ForbiddenException('Only the request creator can edit this request');
    }
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
          title: request.status === 'COMPLETED'
            ? 'Request closed'
            : request.status === 'APPROVED'
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
          message: request.status === 'COMPLETED'
            ? `"${request.title}" was officially closed by its creator.`
            : request.status === 'CANCELLED'
              ? `"${request.title}" was cancelled by its creator.`
              : request.status !== existing.status
                ? `"${request.title}" is now ${request.status.replaceAll('_', ' ').toLowerCase()}.`
                : `"${request.title}" was updated by its creator.`,
          type: 'REQUEST',
          priority: request.priority,
          sourceId: request.id,
          referenceId: request.id,
          resourceType: 'request',
          route: `/requests/${request.id}`,
        },
        [request.requesterId, existing.assignedToId, request.assignedToId]
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
    if (request.requesterId !== actorId) {
      throw new ForbiddenException('Only the request creator can delete this request');
    }
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
      select: { status: true, requesterId: true, assignedToId: true },
    });
    if (existing.requesterId !== actorId) {
      if (!(await hasActivityWritePermission(this.db, actorId, 'requests'))) {
        throw new ForbiddenException('You are not allowed to process this request');
      }
      const allowedTransitions: Record<string, string[]> = {
        PENDING: ['IN_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_INFORMATION'],
        IN_REVIEW: ['APPROVED', 'REJECTED', 'NEEDS_INFORMATION'],
        NEEDS_INFORMATION: ['IN_REVIEW', 'APPROVED', 'REJECTED'],
      };
      if (
        existing.assignedToId !== actorId ||
        !allowedTransitions[existing.status]?.includes(status)
      ) {
        throw new ForbiddenException('Only the request creator or assigned user can make this workflow change');
      }
    }
    const request = await this.db.request.update({
      where: { id },
      data: { status: status as never },
      include: this.requestInclude,
    });
    if (existing.status !== request.status) {
      await this.notifications.suppressPendingPushNotifications('request', request.id);
      await this.notifications.createForUsers(
        {
          title: request.status === 'COMPLETED'
            ? 'Request closed'
            : request.status === 'APPROVED'
            ? 'Request approved'
            : request.status === 'REJECTED'
              ? 'Request rejected'
              : request.status === 'CANCELLED'
                ? 'Request cancelled'
              : request.status === 'NEEDS_INFORMATION'
                ? 'Additional information requested'
                : 'Request status updated',
          message: request.status === 'COMPLETED'
            ? `"${request.title}" was officially closed by its creator.`
            : request.status === 'CANCELLED'
              ? `"${request.title}" was cancelled by its creator.`
              : `"${request.title}" is now ${request.status.replaceAll('_', ' ').toLowerCase()}.`,
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
        updatedAt: true,
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
        updatedAt: true,
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

  async updateComment(requestId: string, commentId: string, userId: string, body: string) {
    await this.ensureRequestAccess(requestId, userId);
    const comment = await this.db.requestComment.findFirst({
      where: { id: commentId, requestId },
      select: { authorId: true },
    });
    if (!comment) {
      throw new NotFoundException('Request comment not found');
    }
    if (comment.authorId !== userId) {
      throw new ForbiddenException('You are not allowed to edit this comment');
    }
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new BadRequestException('Comment cannot be empty');
    }
    return this.db.requestComment.update({
      where: { id: commentId },
      data: { body: trimmedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
    });
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

  async addAttachment(requestId: string, userId: string, file: UploadedAttachmentFile) {
    await this.ensureRequestAccess(requestId, userId);
    const prepared = await this.attachmentStorage.prepareAndUpload('requests', requestId, file);
    try {
      return await this.db.requestAttachment.create({
        data: {
          requestId,
          uploaderId: userId,
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
          size: prepared.size,
          storagePath: prepared.storagePath,
          legacyContent: prepared.inlineContent,
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
        await this.attachmentStorage.remove(prepared.storagePath);
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
    return this.attachmentStorage.resolveContent(attachment, 'Request');
  }

  async deleteAttachment(requestId: string, attachmentId: string, userId: string) {
    await this.ensureRequestAccess(requestId, userId);
    const attachment = await this.db.requestAttachment.findFirst({
      where: { id: attachmentId, requestId },
      select: {
        id: true,
        uploaderId: true,
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
    if (attachment.uploaderId !== userId) {
      throw new ForbiddenException('You are not allowed to delete this attachment');
    }

    const storedContent = attachment.storagePath
      ? await this.attachmentStorage.resolveContent(attachment, 'Request').catch(error => {
          if (error instanceof MissingAttachmentObjectError) {
            return null;
          }
          throw error;
        })
      : null;
    await this.attachmentStorage.remove(attachment.storagePath);
    try {
      await this.db.requestAttachment.delete({ where: { id: attachment.id } });
    } catch (error) {
      if (attachment.storagePath && storedContent) {
        try {
          await this.attachmentStorage.upload(
            attachment.storagePath,
            storedContent.content,
            attachment.mimeType,
          );
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'Unable to delete request attachment metadata or restore its stored file',
          );
        }
      }
      throw error;
    }
    return { id: attachment.id, deleted: true };
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

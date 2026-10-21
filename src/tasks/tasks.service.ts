import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskAttachmentStorageService } from './task-attachment-storage.service';

const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const ATTACHMENT_TYPES = new Map([
  ['.pdf', { mimeType: 'application/pdf', signature: Buffer.from('%PDF-') }],
  ['.doc', { mimeType: 'application/msword', signature: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }],
  ['.docx', {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: Buffer.from('PK')
  }]
]);

@Injectable()
export class TasksService {
  constructor(
    private readonly db: PrismaService,
    private readonly attachmentStorage: TaskAttachmentStorageService,
    private readonly notifications: NotificationsService
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
    isActive: true
  } as const;

  private readonly taskInclude = {
    assignedTo: { select: this.userSelect },
    createdBy: { select: this.userSelect },
    participants: { include: { user: { select: this.userSelect } } },
    _count: { select: { comments: true, attachments: true } }
  } as const;

  async list(userId: string) {
    const canViewAllTasks = await this.hasBroadTaskAccess(userId);
    return this.db.task.findMany({
      where: canViewAllTasks ? undefined : { assignedToId: userId },
      include: this.taskInclude,
      orderBy: { dueDate: 'asc' }
    });
  }

  async create(dto: any, userId: string) {
    const { participantIds, ...taskData } = dto;
    const recipients = [...new Set<string>([dto.assignedToId, ...(participantIds ?? [])])];
    const task = await this.db.task.create({
      data: {
        ...taskData,
        dueDate: new Date(dto.dueDate),
        createdById: userId,
        participants: { create: recipients.map(participantId => ({ userId: participantId })) }
      },
      include: this.taskInclude
    });
    const creator = await this.db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true }
    });
    await this.notifications.createForUsers(
      {
        title: 'New task assigned',
        message: `${creator?.firstName ?? 'A user'} ${creator?.lastName ?? ''} assigned you "${task.title}".${task.description ? ` ${task.description}` : ''}`,
        type: 'TASK_ASSIGNED',
        priority: task.priority,
        sourceId: task.id,
        referenceId: task.id,
        resourceType: 'task',
        route: `/tasks/${task.id}`
      },
      recipients,
      `task_assigned:${task.id}:${task.updatedAt.toISOString()}`,
    );
    return task;
  }

  async get(id: string, userId: string) {
    const item = await this.db.task.findUnique({
      where: { id },
      include: this.taskInclude
    });
    if (!item) {
      throw new NotFoundException('Task not found');
    }
    const isTaskMember =
      item.assignedToId === userId ||
      item.createdById === userId ||
      item.participants.some(participant => participant.userId === userId);
    if (!isTaskMember && !(await this.hasBroadTaskAccess(userId))) {
      throw new ForbiddenException('You are not allowed to access this task');
    }
    return item;
  }

  async update(id: string, dto: any) {
    const { participantIds, ...taskData } = dto;
    const existing = await this.db.task.findUniqueOrThrow({
      where: { id },
      select: { assignedToId: true }
    });
    if (participantIds) {
      await this.db.taskParticipant.deleteMany({ where: { taskId: id } });
    }
    const task = await this.db.task.update({
      where: { id },
      data: {
        ...taskData,
        dueDate: new Date(dto.dueDate),
        ...(participantIds
          ? {
              participants: {
                create: [...new Set<string>(participantIds)].map(userId => ({ userId }))
              }
            }
          : {})
      },
      include: this.taskInclude
    });
    if (task.assignedToId !== existing.assignedToId) {
      await this.notifications.createForUsers(
        {
          title: 'New task assigned',
          message: `${task.createdBy.firstName} ${task.createdBy.lastName} assigned you "${task.title}".${task.description ? ` ${task.description}` : ''}`,
          type: 'TASK_ASSIGNED',
          priority: task.priority,
          sourceId: task.id,
          referenceId: task.id,
          resourceType: 'task',
          route: `/tasks/${task.id}`
        },
        [task.assignedToId],
        `task_assigned:${task.id}:${task.updatedAt.toISOString()}`
      );
    }
    return task;
  }

  remove(id: string) {
    return this.db.task.delete({ where: { id } });
  }

  async status(id: string, status: TaskStatus, userId: string) {
    const task = await this.db.task.findUnique({
      where: { id },
      select: { assignedToId: true, status: true }
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    if (!(await this.hasTaskWritePermission(userId))) {
      const allowedTransition =
        (task.status === TaskStatus.PENDING && status === TaskStatus.IN_PROGRESS) ||
        (task.status === TaskStatus.IN_PROGRESS && status === TaskStatus.COMPLETED);
      if (task.assignedToId !== userId || !allowedTransition) {
        throw new ForbiddenException('Only the assignee can start or complete this task');
      }
    }

    return this.db.task.update({
      where: { id },
      data: { status },
      include: this.taskInclude
    });
  }

  async listComments(taskId: string, userId: string) {
    await this.ensureTaskAccess(taskId, userId);
    return this.db.taskComment.findMany({
      where: { taskId },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: {
          select: { id: true, title: true, firstName: true, lastName: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  async addComment(taskId: string, userId: string, body: string) {
    await this.ensureTaskAccess(taskId, userId);
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const comment = await this.db.taskComment.create({
      data: { taskId, authorId: userId, body: trimmedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: {
          select: { id: true, title: true, firstName: true, lastName: true }
        }
      }
    });
    const task = await this.db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: {
        title: true,
        assignedToId: true,
        createdById: true,
        participants: { select: { userId: true } }
      }
    });
    const recipients = [
      task.assignedToId,
      task.createdById,
      ...task.participants.map(participant => participant.userId)
    ].filter(recipientId => recipientId !== userId);
    await this.notifications.createForUsers(
      {
        title: 'New task comment',
        message: `${comment.author.firstName} ${comment.author.lastName} commented on "${task.title}".`,
        type: 'COMMENT',
        priority: 'MEDIUM',
        sourceId: taskId,
        referenceId: taskId,
        resourceType: 'task',
        route: `/tasks/${taskId}?comment=${comment.id}`
      },
      recipients,
      `task_comment:${comment.id}`,
    );
    return comment;
  }

  async listAttachments(taskId: string, userId: string) {
    await this.ensureTaskAccess(taskId, userId);
    return this.db.taskAttachment.findMany({
      where: { taskId },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        size: true,
        createdAt: true,
        uploader: {
          select: { id: true, firstName: true, lastName: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });
  }

  async addAttachment(
    taskId: string,
    userId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer }
  ) {
    await this.ensureTaskAccess(taskId, userId);
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
    if (
      !fileType ||
      (file.mimetype !== fileType.mimeType && file.mimetype !== 'application/octet-stream')
    ) {
      throw new BadRequestException('Only valid PDF and Word documents are supported');
    }
    if (!this.hasValidFileSignature(extension, file.buffer)) {
      throw new BadRequestException('The uploaded file content does not match its file type');
    }

    const storagePath = `${taskId}/${randomUUID()}${extension}`;
    await this.attachmentStorage.upload(storagePath, file.buffer, fileType.mimeType);
    try {
      return await this.db.taskAttachment.create({
        data: {
          taskId,
          uploaderId: userId,
          fileName,
          mimeType: fileType.mimeType,
          size: file.size,
          storagePath
        },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          size: true,
          createdAt: true,
          uploader: {
            select: { id: true, firstName: true, lastName: true }
          }
        }
      });
    } catch (error) {
      try {
        await this.attachmentStorage.remove(storagePath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Unable to save attachment metadata or clean up its stored object'
        );
      }
      throw error;
    }
  }

  async getAttachment(taskId: string, attachmentId: string, userId: string) {
    await this.ensureTaskAccess(taskId, userId);
    const attachment = await this.db.taskAttachment.findFirst({
      where: { id: attachmentId, taskId },
      select: {
        fileName: true,
        mimeType: true,
        size: true,
        storagePath: true,
        legacyContent: true
      }
    });
    if (!attachment) {
      throw new NotFoundException('Task attachment not found');
    }
    if (attachment.storagePath) {
      return {
        ...attachment,
        content: await this.attachmentStorage.download(attachment.storagePath)
      };
    }
    if (attachment.legacyContent) {
      return { ...attachment, content: Buffer.from(attachment.legacyContent) };
    }
    throw new BadGatewayException('Task attachment is missing its stored file');
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

  private async ensureTaskAccess(taskId: string, userId: string): Promise<void> {
    const task = await this.db.task.findUnique({
      where: { id: taskId },
      select: {
        assignedToId: true,
        createdById: true,
        participants: { select: { userId: true } }
      }
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const isTaskMember =
      task.assignedToId === userId ||
      task.createdById === userId ||
      task.participants.some(participant => participant.userId === userId);
    if (!isTaskMember && !(await this.hasBroadTaskAccess(userId))) {
      throw new ForbiddenException('You are not allowed to access this task');
    }
  }

  private async hasBroadTaskAccess(userId: string): Promise<boolean> {
    return this.hasTaskPermission(userId, ['read', 'write']);
  }

  private async hasTaskWritePermission(userId: string): Promise<boolean> {
    return this.hasTaskPermission(userId, ['write']);
  }

  private async hasTaskPermission(userId: string, actions: readonly string[]): Promise<boolean> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        role: true,
        roleRef: { select: this.taskRoleSelect }
      }
    });
    if (!user?.isActive) {
      return false;
    }
    const role = user.roleRef ?? await this.db.role.findUnique({
      where: { name: user.role },
      select: this.taskRoleSelect
    });
    return Boolean(
      role?.isActive &&
      role.permissions.some(({ permission }) =>
        permission.resource === 'tasks' && actions.includes(permission.action)
      )
    );
  }

  private readonly taskRoleSelect = {
    isActive: true,
    permissions: {
      select: {
        permission: {
          select: { resource: true, action: true }
        }
      }
    }
  } as const;
}

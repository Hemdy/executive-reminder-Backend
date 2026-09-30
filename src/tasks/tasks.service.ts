import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';

const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;

@Injectable()
export class TasksService {
  constructor(private readonly db: PrismaService) {}

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

  list(userId: string) {
    return this.db.task.findMany({
      where: {
        OR: [
          { assignedToId: userId },
          { createdById: userId },
          { participants: { some: { userId } } }
        ]
      },
      include: this.taskInclude,
      orderBy: { dueDate: 'asc' }
    });
  }

  async create(dto: any, userId: string) {
    const { participantIds, ...taskData } = dto;
    const recipients = [...new Set<string>(participantIds?.length ? participantIds : [dto.assignedToId])];
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
    await this.db.notification.createMany({
      data: recipients.map(recipientId => ({
        userId: recipientId,
        title: 'New task assigned',
        message: `${creator?.firstName ?? 'A user'} ${creator?.lastName ?? ''} assigned you "${task.title}".${task.description ? ` ${task.description}` : ''}`,
        type: 'TASK_ASSIGNED' as const,
        priority: task.priority,
        sourceId: task.id,
        referenceId: task.id,
        resourceType: 'task',
        route: `/tasks/${task.id}`
      }))
    });
    return task;
  }

  async get(id: string) {
    const item = await this.db.task.findUnique({
      where: { id },
      include: this.taskInclude
    });
    if (!item) {
      throw new NotFoundException('Task not found');
    }
    return item;
  }

  async update(id: string, dto: any) {
    const { participantIds, ...taskData } = dto;
    if (participantIds) {
      await this.db.taskParticipant.deleteMany({ where: { taskId: id } });
    }
    return this.db.task.update({
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
    return this.db.taskComment.create({
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

    return this.db.taskAttachment.create({
      data: {
        taskId,
        uploaderId: userId,
        fileName,
        mimeType: file.mimetype,
        size: file.size,
        content: Uint8Array.from(file.buffer)
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
  }

  async getAttachment(taskId: string, attachmentId: string, userId: string) {
    await this.ensureTaskAccess(taskId, userId);
    const attachment = await this.db.taskAttachment.findFirst({
      where: { id: attachmentId, taskId },
      select: { fileName: true, mimeType: true, size: true, content: true }
    });
    if (!attachment) {
      throw new NotFoundException('Task attachment not found');
    }
    return attachment;
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
    if (!isTaskMember && !(await this.hasTaskWritePermission(userId))) {
      throw new ForbiddenException('You are not allowed to access this task');
    }
  }

  private async hasTaskWritePermission(userId: string): Promise<boolean> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        roleRef: {
          select: {
            isActive: true,
            permissions: {
              select: {
                permission: {
                  select: { resource: true, action: true }
                }
              }
            }
          }
        }
      }
    });
    return Boolean(
      user?.isActive &&
      user.roleRef?.isActive &&
      user.roleRef.permissions.some(
        ({ permission }) => permission.resource === 'tasks' && permission.action === 'write'
      )
    );
  }
}

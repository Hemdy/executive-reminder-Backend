import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import { UploadedAttachmentFile } from '../common/attachment-response';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskAttachmentStorageService } from './task-attachment-storage.service';

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
      recipients.filter(recipientId => recipientId !== userId),
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

  async update(id: string, dto: any, userId: string) {
    const { participantIds, ...taskData } = dto;
    const existing = await this.db.task.findUniqueOrThrow({
      where: { id },
      select: {
        assignedToId: true,
        createdById: true,
        status: true,
        dueDate: true,
        title: true,
        description: true,
        priority: true,
        category: true,
        participants: { select: { userId: true } }
      }
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
    const assignmentChanged = task.assignedToId !== existing.assignedToId;
    const statusChanged = task.status !== existing.status;
    const deadlineChanged = task.dueDate.getTime() !== existing.dueDate.getTime();
    const contentChanged =
      task.title !== existing.title ||
      task.description !== existing.description ||
      task.priority !== existing.priority ||
      task.category !== existing.category;
    const participantsChanged =
      existing.participants.length !== task.participants.length ||
      existing.participants.some(({ userId: participantId }) =>
        !task.participants.some(participant => participant.userId === participantId)
      );
    const recipients = [
      task.assignedToId,
      task.createdById,
      ...task.participants.map(({ userId: participantId }) => participantId)
    ].filter(recipientId => recipientId !== userId);
    const title = assignmentChanged
      ? 'Task assignment updated'
      : statusChanged
        ? task.status === 'CANCELLED'
          ? 'Task cancelled'
          : task.status === 'COMPLETED'
            ? 'Task completed'
            : 'Task status updated'
        : deadlineChanged
          ? 'Task deadline updated'
          : participantsChanged
            ? 'Task participants updated'
            : 'Task updated';
    const message = assignmentChanged
      ? `"${task.title}" has been assigned to ${task.assignedTo.firstName} ${task.assignedTo.lastName}.`
      : statusChanged
        ? `"${task.title}" is now ${task.status.replaceAll('_', ' ').toLowerCase()}.`
        : deadlineChanged
          ? `The deadline for "${task.title}" has changed to ${task.dueDate.toISOString().slice(0, 10)}.`
          : participantsChanged
            ? `The participants for "${task.title}" have changed.`
            : `"${task.title}" has been updated.`;
    if (assignmentChanged || statusChanged || deadlineChanged || participantsChanged || contentChanged) {
      await this.notifications.suppressPendingPushNotifications('task', task.id);
      if (recipients.length) {
        await this.notifications.createForUsers(
          {
            title,
            message,
            type: statusChanged ? 'TASK_STATUS' : assignmentChanged ? 'TASK_ASSIGNED' : 'TASK_UPDATED',
            priority: task.priority,
            sourceId: task.id,
            referenceId: task.id,
            resourceType: 'task',
            route: `/tasks/${task.id}`
          },
          recipients,
          `task_updated:${task.id}:${task.updatedAt.toISOString()}`
        );
      }
    }
    return task;
  }

  async remove(id: string, userId: string) {
    const task = await this.db.task.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        title: true,
        priority: true,
        createdAt: true,
        assignedToId: true,
        createdById: true,
        participants: { select: { userId: true } }
      }
    });
    await this.notifications.suppressPendingPushNotifications('task', task.id);
    await this.notifications.createForUsers(
      {
        title: 'Task deleted',
        message: `"${task.title}" was deleted.`,
        type: 'TASK_UPDATED',
        priority: task.priority,
        sourceId: task.id,
        referenceId: task.id,
        resourceType: 'task',
        route: '/tasks'
      },
      [task.assignedToId, task.createdById, ...task.participants.map(({ userId: id }) => id)]
        .filter(recipientId => recipientId !== userId),
      `task_deleted:${task.id}:${task.createdAt.toISOString()}`
    );
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

    const updated = await this.db.task.update({
      where: { id },
      data: { status },
      include: this.taskInclude
    });
    if (task.status !== status) {
      const recipients = [
        updated.assignedToId,
        updated.createdById,
        ...updated.participants.map(({ userId: participantId }) => participantId)
      ].filter(recipientId => recipientId !== userId);
      await this.notifications.suppressPendingPushNotifications('task', updated.id);
      await this.notifications.createForUsers(
        {
          title: status === TaskStatus.CANCELLED
            ? 'Task cancelled'
            : status === TaskStatus.COMPLETED
              ? 'Task completed'
              : 'Task status updated',
          message: `"${updated.title}" is now ${updated.status.replaceAll('_', ' ').toLowerCase()}.`,
          type: 'TASK_STATUS',
          priority: updated.priority,
          sourceId: updated.id,
          referenceId: updated.id,
          resourceType: 'task',
          route: `/tasks/${updated.id}`
        },
        recipients,
        `task_status:${updated.id}:${updated.updatedAt.toISOString()}`
      );
    }
    return updated;
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
    file: UploadedAttachmentFile
  ) {
    await this.ensureTaskAccess(taskId, userId);
    const prepared = await this.attachmentStorage.prepareAndUpload('tasks', taskId, file);
    try {
      return await this.db.taskAttachment.create({
        data: {
          taskId,
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
          uploader: {
            select: { id: true, firstName: true, lastName: true }
          }
        }
      });
    } catch (error) {
      try {
        await this.attachmentStorage.remove(prepared.storagePath);
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
    return this.attachmentStorage.resolveContent(attachment, 'Task');
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

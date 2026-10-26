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
export class RemindersService {
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

  private readonly reminderInclude = {
    recipient: { select: this.userSelect },
    createdBy: { select: this.userSelect },
    participants: { include: { user: { select: this.userSelect } } },
    _count: { select: { comments: true, attachments: true } },
  } as const;

  list(userId: string) {
    return this.db.reminder.findMany({
      where: {
        OR: [
          { recipientId: userId },
          { createdById: userId },
          { participants: { some: { userId } } },
        ],
      },
      include: this.reminderInclude,
      orderBy: { reminderDate: 'asc' },
    });
  }

  async create(dto: any, userId: string) {
    const { participantIds, ...reminderData } = dto;
    const recipients = [...new Set<string>([dto.recipientId, ...(participantIds ?? [])])];
    const reminder = await this.db.reminder.create({
      data: {
        ...reminderData,
        reminderDate: new Date(dto.reminderDate),
        createdById: userId,
        participants: { create: recipients.map(recipientId => ({ userId: recipientId })) },
      },
      include: this.reminderInclude,
    });

    await this.notifications.createForUsers(
      {
        title: 'New reminder',
        message: `${reminder.createdBy.firstName} ${reminder.createdBy.lastName} set a reminder for you: "${reminder.title}".${reminder.description ? ` ${reminder.description}` : ''}`,
        type: 'REMINDER',
        priority: reminder.priority,
        sourceId: reminder.id,
        referenceId: reminder.id,
        resourceType: 'reminder',
        route: `/reminders/${reminder.id}`,
      },
      recipients.filter(recipientId => recipientId !== userId),
      `reminder_created:${reminder.id}`,
    );
    return reminder;
  }

  async get(id: string, userId: string) {
    const reminder = await this.db.reminder.findUnique({
      where: { id },
      include: this.reminderInclude,
    });
    if (!reminder) {
      throw new NotFoundException('Reminder not found');
    }
    const canAccess =
      reminder.recipientId === userId ||
      reminder.createdById === userId ||
      reminder.participants.some(participant => participant.userId === userId);
    if (!canAccess) {
      throw new ForbiddenException('You are not allowed to access this reminder');
    }
    return reminder;
  }

  async update(id: string, dto: any, userId: string) {
    const { participantIds, ...reminderData } = dto;
    const existing = await this.db.reminder.findUniqueOrThrow({
      where: { id },
      select: {
        recipientId: true,
        createdById: true,
        reminderDate: true,
        reminderTime: true,
        title: true,
        description: true,
        priority: true,
        category: true,
        recurrence: true,
        status: true,
        participants: { select: { userId: true } },
      },
    });
    if (participantIds) {
      await this.db.reminderParticipant.deleteMany({ where: { reminderId: id } });
    }
    const reminder = await this.db.reminder.update({
      where: { id },
      data: {
        ...reminderData,
        reminderDate: new Date(dto.reminderDate),
        ...(participantIds
          ? {
              participants: {
                create: [...new Set<string>(participantIds)].map(userId => ({ userId })),
              },
            }
          : {}),
      },
      include: this.reminderInclude,
    });
    const scheduleChanged =
      reminder.reminderDate.getTime() !== existing.reminderDate.getTime() ||
      reminder.reminderTime !== existing.reminderTime ||
      reminder.recurrence !== existing.recurrence;
    const contentChanged =
      reminder.title !== existing.title ||
      reminder.description !== existing.description ||
      reminder.priority !== existing.priority ||
      reminder.category !== existing.category;
    const recipientChanged = reminder.recipientId !== existing.recipientId;
    const statusChanged = reminder.status !== existing.status;
    const priorParticipantIds = existing.participants.map(({ userId }) => userId);
    const updatedParticipantIds = reminder.participants.map(({ userId }) => userId);
    const participantsChanged =
      priorParticipantIds.length !== updatedParticipantIds.length ||
      priorParticipantIds.some(userId => !updatedParticipantIds.includes(userId));
    const recipients = [
      reminder.recipientId,
      reminder.createdById,
      ...reminder.participants.map(({ userId: participantId }) => participantId),
    ].filter(recipientId => recipientId !== userId);
    if (scheduleChanged || contentChanged || recipientChanged || statusChanged || participantsChanged) {
      await this.notifications.suppressPendingPushNotifications('reminder', reminder.id);
      if (recipients.length) {
        await this.notifications.createForUsers(
          {
            title: scheduleChanged
              ? 'Reminder rescheduled'
              : recipientChanged
                ? 'Reminder reassigned'
                : statusChanged
                  ? reminder.status === 'CANCELLED' || reminder.status === 'DISMISSED'
                    ? 'Reminder cancelled'
                    : reminder.status === 'COMPLETED'
                      ? 'Reminder completed'
                      : 'Reminder status updated'
                  : participantsChanged
                    ? 'Reminder participants updated'
                    : 'Reminder updated',
            message: scheduleChanged
              ? `"${reminder.title}" is scheduled for ${reminder.reminderDate.toISOString().slice(0, 10)} at ${reminder.reminderTime}.`
              : statusChanged
                ? `"${reminder.title}" is now ${reminder.status.replaceAll('_', ' ').toLowerCase()}.`
                : `"${reminder.title}" has been updated.`,
            type: 'REMINDER',
            priority: reminder.priority,
            sourceId: reminder.id,
            referenceId: reminder.id,
            resourceType: 'reminder',
            route: `/reminders/${reminder.id}`,
          },
          recipients,
          `reminder_updated:${reminder.id}:${reminder.updatedAt.toISOString()}`,
        );
      }
    }
    return reminder;
  }

  async remove(id: string, userId: string) {
    const reminder = await this.db.reminder.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        title: true,
        priority: true,
        createdAt: true,
        recipientId: true,
        createdById: true,
        participants: { select: { userId: true } },
      },
    });
    await this.notifications.suppressPendingPushNotifications('reminder', reminder.id);
    await this.notifications.createForUsers(
      {
        title: 'Reminder deleted',
        message: `"${reminder.title}" was deleted.`,
        type: 'REMINDER',
        priority: reminder.priority,
        sourceId: reminder.id,
        referenceId: reminder.id,
        resourceType: 'reminder',
        route: '/reminders',
      },
      [reminder.recipientId, reminder.createdById, ...reminder.participants.map(({ userId: id }) => id)]
        .filter(recipientId => recipientId !== userId),
      `reminder_deleted:${reminder.id}:${reminder.createdAt.toISOString()}`,
    );
    return this.db.reminder.delete({ where: { id } });
  }

  async status(id: string, status: string, userId: string) {
    const existing = await this.db.reminder.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    const reminder = await this.db.reminder.update({
      where: { id },
      data: { status: status as never },
      include: this.reminderInclude,
    });
    if (existing.status !== reminder.status) {
      const recipients = [
        reminder.recipientId,
        reminder.createdById,
        ...reminder.participants.map(({ userId: participantId }) => participantId),
      ].filter(recipientId => recipientId !== userId);
      await this.notifications.suppressPendingPushNotifications('reminder', reminder.id);
      await this.notifications.createForUsers(
        {
          title: reminder.status === 'CANCELLED' || reminder.status === 'DISMISSED'
            ? 'Reminder cancelled'
            : reminder.status === 'COMPLETED'
              ? 'Reminder completed'
              : 'Reminder status updated',
          message: `"${reminder.title}" is now ${reminder.status.replaceAll('_', ' ').toLowerCase()}.`,
          type: 'REMINDER',
          priority: reminder.priority,
          sourceId: reminder.id,
          referenceId: reminder.id,
          resourceType: 'reminder',
          route: `/reminders/${reminder.id}`,
        },
        recipients,
        `reminder_status:${reminder.id}:${reminder.updatedAt.toISOString()}`,
      );
    }
    return reminder;
  }

  async listComments(reminderId: string, userId: string) {
    await this.ensureReminderAccess(reminderId, userId);
    return this.db.reminderComment.findMany({
      where: { reminderId },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(reminderId: string, userId: string, body: string) {
    await this.ensureReminderAccess(reminderId, userId);
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const comment = await this.db.reminderComment.create({
      data: { reminderId, authorId: userId, body: trimmedBody },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
    });
    const reminder = await this.db.reminder.findUniqueOrThrow({
      where: { id: reminderId },
      select: {
        title: true,
        recipientId: true,
        createdById: true,
        participants: { select: { userId: true } },
      },
    });
    const recipients = [reminder.recipientId, reminder.createdById, ...reminder.participants.map(participant => participant.userId)].filter(id => id !== userId);
    await this.notifications.createForUsers(
      {
        title: 'New reminder comment',
        message: `${comment.author.firstName} ${comment.author.lastName} commented on "${reminder.title}".`,
        type: 'COMMENT',
        priority: 'MEDIUM',
        sourceId: reminderId,
        referenceId: reminderId,
        resourceType: 'reminder',
        route: `/reminders/${reminderId}?comment=${comment.id}`,
      },
      recipients,
      `reminder_comment:${comment.id}`,
    );
    return comment;
  }

  async listAttachments(reminderId: string, userId: string) {
    await this.ensureReminderAccess(reminderId, userId);
    return this.db.reminderAttachment.findMany({
      where: { reminderId },
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

  async addAttachment(reminderId: string, userId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
    await this.ensureReminderAccess(reminderId, userId);
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

    const storagePath = `${reminderId}/${randomUUID()}${extension}`;
    await this.attachmentStorage.upload(storagePath, file.buffer, fileType.mimeType);
    try {
      return await this.db.reminderAttachment.create({
        data: {
          reminderId,
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
        throw new AggregateError([error, cleanupError], 'Unable to save reminder attachment metadata or clean up its stored object');
      }
      throw error;
    }
  }

  async getAttachment(reminderId: string, attachmentId: string, userId: string) {
    await this.ensureReminderAccess(reminderId, userId);
    const attachment = await this.db.reminderAttachment.findFirst({
      where: { id: attachmentId, reminderId },
      select: {
        fileName: true,
        mimeType: true,
        size: true,
        storagePath: true,
        legacyContent: true,
      },
    });
    if (!attachment) {
      throw new NotFoundException('Reminder attachment not found');
    }
    if (attachment.storagePath) {
      return { ...attachment, content: await this.attachmentStorage.download(attachment.storagePath) };
    }
    if (attachment.legacyContent) {
      return { ...attachment, content: Buffer.from(attachment.legacyContent) };
    }
    throw new BadGatewayException('Reminder attachment is missing its stored file');
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

  private async ensureReminderAccess(reminderId: string, userId: string): Promise<void> {
    const reminder = await this.db.reminder.findUnique({
      where: { id: reminderId },
      select: { recipientId: true, createdById: true, participants: { select: { userId: true } } },
    });
    if (!reminder) {
      throw new NotFoundException('Reminder not found');
    }
    const canAccess =
      reminder.recipientId === userId ||
      reminder.createdById === userId ||
      reminder.participants.some(participant => participant.userId === userId);
    if (!canAccess) {
      throw new ForbiddenException('You are not allowed to access this reminder');
    }
  }
}

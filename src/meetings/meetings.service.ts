import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UploadedAttachmentFile } from '../common/attachment-response';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TaskAttachmentStorageService } from '../tasks/task-attachment-storage.service';

@Injectable()
export class MeetingsService {
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

  private readonly meetingInclude = {
    organizer: { select: this.userSelect },
    participants: { include: { user: { select: this.userSelect } } },
    _count: { select: { comments: true, attachments: true } },
  } as const;

  list(userId: string) {
    return this.db.meeting.findMany({
      where: { OR: [{ organizerId: userId }, { participants: { some: { userId } } }] },
      include: this.meetingInclude,
      orderBy: { meetingDate: 'asc' },
    });
  }

  async create(dto: any, organizerId: string) {
    const { participantIds = [], ...data } = dto;
    const invitedIds = [...new Set<string>(participantIds)];
    const meeting = await this.db.meeting.create({
      data: {
        ...data,
        meetingDate: new Date(data.meetingDate),
        organizerId,
        participants: { create: invitedIds.map(userId => ({ userId })) },
      },
      include: this.meetingInclude,
    });

    const recipients = invitedIds.filter(userId => userId !== organizerId);
    if (recipients.length) {
      await this.notifications.createForUsers(
        {
          title: 'New meeting invitation',
          message: `${meeting.organizer.firstName} ${meeting.organizer.lastName} invited you to "${meeting.title}". Scheduled for ${meeting.meetingDate.toISOString().slice(0, 10)} at ${meeting.startTime}.`,
          type: 'MEETING',
          priority: 'MEDIUM',
          sourceId: meeting.id,
          referenceId: meeting.id,
          resourceType: 'meeting',
          route: `/meetings/${meeting.id}`,
        },
        recipients,
        `meeting_scheduled:${meeting.id}`,
      );
    }
    return meeting;
  }

  async get(id: string, userId: string) {
    const meeting = await this.db.meeting.findUnique({ where: { id }, include: this.meetingInclude });
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    await this.ensureMeetingAccess(id, userId);
    return meeting;
  }

  async update(id: string, dto: any, actorId: string) {
    const { participantIds = [], ...data } = dto;
    const existing = await this.db.meeting.findUniqueOrThrow({
      where: { id },
      select: {
        organizerId: true,
        title: true,
        description: true,
        agenda: true,
        meetingDate: true,
        startTime: true,
        endTime: true,
        location: true,
        meetingType: true,
        status: true,
        participants: { select: { userId: true } },
      },
    });
    await this.db.meetingParticipant.deleteMany({ where: { meetingId: id } });
    const meeting = await this.db.meeting.update({
      where: { id },
      data: {
        ...data,
        meetingDate: new Date(data.meetingDate),
        participants: { create: [...new Set<string>(participantIds)].map(userId => ({ userId })) },
      },
      include: this.meetingInclude,
    });
    const oldParticipantIds = existing.participants.map(({ userId }) => userId);
    const newParticipantIds = meeting.participants.map(({ userId }) => userId);
    const participantsChanged =
      oldParticipantIds.length !== newParticipantIds.length ||
      oldParticipantIds.some(userId => !newParticipantIds.includes(userId));
    const detailsChanged =
      meeting.title !== existing.title ||
      meeting.description !== existing.description ||
      meeting.agenda !== existing.agenda ||
      meeting.meetingDate.getTime() !== existing.meetingDate.getTime() ||
      meeting.startTime !== existing.startTime ||
      meeting.endTime !== existing.endTime ||
      meeting.location !== existing.location ||
      meeting.meetingType !== existing.meetingType ||
      meeting.status !== existing.status;
    if (participantsChanged || detailsChanged) {
      await this.notifications.suppressPendingPushNotifications('meeting', meeting.id);
      await this.notifications.createForUsers(
        {
          title: meeting.status === 'CANCELLED' ? 'Meeting cancelled' : 'Meeting updated',
          message: meeting.status === 'CANCELLED'
            ? `"${meeting.title}" has been cancelled.`
            : `"${meeting.title}" has been updated. It is scheduled for ${meeting.meetingDate.toISOString().slice(0, 10)} at ${meeting.startTime}.`,
          type: 'MEETING',
          priority: 'MEDIUM',
          sourceId: meeting.id,
          referenceId: meeting.id,
          resourceType: 'meeting',
          route: `/meetings/${meeting.id}`,
        },
        [
          meeting.organizerId,
          ...newParticipantIds,
        ].filter(recipientId => recipientId !== actorId),
        `meeting_updated:${meeting.id}:${meeting.updatedAt.toISOString()}`,
      );
    }
    return meeting;
  }

  async listComments(meetingId: string, userId: string) {
    await this.ensureMeetingAccess(meetingId, userId);
    return this.db.meetingComment.findMany({
      where: { meetingId },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(meetingId: string, userId: string, body: string) {
    await this.ensureMeetingAccess(meetingId, userId);
    const text = body.trim();
    if (!text) {
      throw new BadRequestException('Comment cannot be empty');
    }
    const comment = await this.db.meetingComment.create({
      data: { meetingId, authorId: userId, body: text },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: { select: { id: true, title: true, firstName: true, lastName: true } },
      },
    });
    const meeting = await this.db.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      select: {
        title: true,
        organizerId: true,
        participants: { select: { userId: true } },
      },
    });
    const recipients = [meeting.organizerId, ...meeting.participants.map(participant => participant.userId)].filter(id => id !== userId);
    await this.notifications.createForUsers(
      {
        title: 'New meeting comment',
        message: `${comment.author.firstName} ${comment.author.lastName} commented on "${meeting.title}".`,
        type: 'COMMENT',
        priority: 'MEDIUM',
        sourceId: meetingId,
        referenceId: meetingId,
        resourceType: 'meeting',
        route: `/meetings/${meetingId}?comment=${comment.id}`,
      },
      recipients,
      `meeting_comment:${comment.id}`,
    );
    return comment;
  }

  async listAttachments(meetingId: string, userId: string) {
    await this.ensureMeetingAccess(meetingId, userId);
    return this.db.meetingAttachment.findMany({
      where: { meetingId },
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

  async addAttachment(meetingId: string, userId: string, file: UploadedAttachmentFile) {
    await this.ensureMeetingAccess(meetingId, userId);
    const prepared = await this.attachmentStorage.prepareAndUpload('meetings', meetingId, file);
    try {
      return await this.db.meetingAttachment.create({
        data: {
          meetingId,
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
        throw new AggregateError([error, cleanupError], 'Unable to save meeting attachment metadata or clean up its stored object');
      }
      throw error;
    }
  }

  async getAttachment(meetingId: string, attachmentId: string, userId: string) {
    await this.ensureMeetingAccess(meetingId, userId);
    const attachment = await this.db.meetingAttachment.findFirst({
      where: { id: attachmentId, meetingId },
      select: {
        fileName: true,
        mimeType: true,
        size: true,
        storagePath: true,
        legacyContent: true,
      },
    });
    if (!attachment) {
      throw new NotFoundException('Meeting attachment not found');
    }
    return this.attachmentStorage.resolveContent(attachment, 'Meeting');
  }

  async remove(id: string, actorId: string) {
    const meeting = await this.db.meeting.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        title: true,
        organizerId: true,
        createdAt: true,
        participants: { select: { userId: true } },
      },
    });
    await this.notifications.suppressPendingPushNotifications('meeting', meeting.id);
    await this.notifications.createForUsers(
      {
        title: 'Meeting deleted',
        message: `"${meeting.title}" was deleted.`,
        type: 'MEETING',
        priority: 'MEDIUM',
        sourceId: meeting.id,
        referenceId: meeting.id,
        resourceType: 'meeting',
        route: '/meetings',
      },
      [meeting.organizerId, ...meeting.participants.map(({ userId }) => userId)]
        .filter(recipientId => recipientId !== actorId),
      `meeting_deleted:${meeting.id}:${meeting.createdAt.toISOString()}`,
    );
    return this.db.meeting.delete({ where: { id } });
  }

  async status(id: string, status: string, actorId: string) {
    const existing = await this.db.meeting.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    const meeting = await this.db.meeting.update({
      where: { id },
      data: { status: status as never },
      include: this.meetingInclude,
    });
    if (existing.status !== meeting.status) {
      await this.notifications.suppressPendingPushNotifications('meeting', meeting.id);
      await this.notifications.createForUsers(
        {
          title: meeting.status === 'CANCELLED' ? 'Meeting cancelled' : 'Meeting status updated',
          message: meeting.status === 'CANCELLED'
            ? `"${meeting.title}" has been cancelled.`
            : `"${meeting.title}" is now ${meeting.status.replaceAll('_', ' ').toLowerCase()}.`,
          type: 'MEETING',
          priority: 'MEDIUM',
          sourceId: meeting.id,
          referenceId: meeting.id,
          resourceType: 'meeting',
          route: `/meetings/${meeting.id}`,
        },
        [meeting.organizerId, ...meeting.participants.map(({ userId }) => userId)]
          .filter(recipientId => recipientId !== actorId),
        `meeting_status:${meeting.id}:${meeting.updatedAt.toISOString()}`,
      );
    }
    return meeting;
  }

  private async ensureMeetingAccess(meetingId: string, userId: string): Promise<void> {
    const meeting = await this.db.meeting.findUnique({
      where: { id: meetingId },
      select: {
        organizerId: true,
        participants: { select: { userId: true } },
      },
    });
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    if (
      meeting.organizerId !== userId &&
      !meeting.participants.some(participant => participant.userId === userId)
    ) {
      throw new ForbiddenException('You are not allowed to access this meeting');
    }
  }
}

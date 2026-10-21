import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class MeetingsService {
  constructor(
    private readonly db: PrismaService,
    private readonly notifications: NotificationsService,
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

    if (invitedIds.length) {
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
        invitedIds,
        `meeting_scheduled:${meeting.id}`,
      );
    }
    return meeting;
  }

  get(id: string) {
    return this.db.meeting.findUniqueOrThrow({ where: { id }, include: this.meetingInclude });
  }

  async update(id: string, dto: any) {
    const { participantIds = [], ...data } = dto;
    await this.db.meetingParticipant.deleteMany({ where: { meetingId: id } });
    return this.db.meeting.update({
      where: { id },
      data: {
        ...data,
        meetingDate: new Date(data.meetingDate),
        participants: { create: [...new Set<string>(participantIds)].map(userId => ({ userId })) },
      },
      include: this.meetingInclude,
    });
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
    const recipients = [
      meeting.organizerId,
      ...meeting.participants.map(participant => participant.userId),
    ].filter(id => id !== userId);
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

  remove(id: string) {
    return this.db.meeting.delete({ where: { id } });
  }

  status(id: string, status: string) {
    return this.db.meeting.update({
      where: { id },
      data: { status: status as never },
      include: this.meetingInclude,
    });
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

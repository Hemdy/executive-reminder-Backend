import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class RemindersService {
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

  private readonly reminderInclude = {
    recipient: { select: this.userSelect },
    createdBy: { select: this.userSelect },
    participants: { include: { user: { select: this.userSelect } } },
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
      recipients,
      `reminder_created:${reminder.id}`,
    );
    return reminder;
  }

  get(id: string) {
    return this.db.reminder.findUniqueOrThrow({ where: { id }, include: this.reminderInclude });
  }

  async update(id: string, dto: any) {
    const { participantIds, ...reminderData } = dto;
    if (participantIds) {
      await this.db.reminderParticipant.deleteMany({ where: { reminderId: id } });
    }
    return this.db.reminder.update({
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
  }

  remove(id: string) {
    return this.db.reminder.delete({ where: { id } });
  }

  status(id: string, status: string) {
    return this.db.reminder.update({
      where: { id },
      data: { status: status as never },
      include: this.reminderInclude,
    });
  }
}

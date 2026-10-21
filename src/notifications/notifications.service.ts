import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Priority, ReminderRecurrence, ReminderStatus } from '@prisma/client';
import webPush from 'web-push';
import { PrismaService } from '../prisma.service';

interface NotificationEvent {
  title: string;
  message: string;
  type: NotificationType;
  priority: Priority;
  sourceId?: string;
  referenceId?: string;
  resourceType?: string;
  route?: string;
}

interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly vapidPublicKey: string;
  private readonly vapidConfigured: boolean;
  private readonly reminderTimezone: string;

  constructor(
    private readonly db: PrismaService,
    config: ConfigService,
  ) {
    this.vapidPublicKey = config.get<string>('VAPID_PUBLIC_KEY') ?? '';
    const vapidPrivateKey = config.get<string>('VAPID_PRIVATE_KEY') ?? '';
    const vapidSubject = config.get<string>('VAPID_SUBJECT') ?? '';
    this.vapidConfigured = Boolean(this.vapidPublicKey && vapidPrivateKey && vapidSubject);
    this.reminderTimezone = config.get<string>('REMINDER_TIMEZONE') ?? 'Africa/Lagos';

    if (this.vapidConfigured) {
      webPush.setVapidDetails(vapidSubject, this.vapidPublicKey, vapidPrivateKey);
    }
  }

  list(userId: string) {
    return this.db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  create(
    data: {
      title: string;
      message: string;
      type: string;
      priority: string;
      sourceId?: string;
      referenceId?: string;
      resourceType?: string;
      route?: string;
    },
    userId: string,
  ) {
    return this.db.notification.create({
      data: { ...data, userId, type: data.type as never, priority: data.priority as never },
    });
  }

  async createForUsers(
    data: NotificationEvent,
    recipientIds: string[],
    eventKey: string,
  ): Promise<void> {
    const users = await this.db.user.findMany({
      where: { id: { in: [...new Set(recipientIds)] }, isActive: true },
      select: { id: true },
    });

    for (const user of users) {
      await this.db.$transaction(async transaction => {
        const event = await transaction.notificationEvent.createMany({
          data: [{ userId: user.id, eventKey }],
          skipDuplicates: true,
        });
        if (event.count) {
          await transaction.notification.create({
            data: { ...data, userId: user.id, eventKey },
          });
        }
      });
    }
  }

  pushConfig() {
    return { enabled: this.vapidConfigured, publicKey: this.vapidConfigured ? this.vapidPublicKey : null };
  }

  async savePushSubscription(userId: string, input: PushSubscriptionInput): Promise<void> {
    if (!this.isPushServiceEndpoint(input.endpoint)) {
      throw new BadRequestException('The push service endpoint is not supported');
    }
    const existing = await this.db.pushSubscription.findUnique({
      where: { endpoint: input.endpoint },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) {
      throw new ForbiddenException('This push subscription belongs to another user');
    }

    const subscriptionData = {
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        expirationTime: input.expirationTime == null ? null : BigInt(input.expirationTime),
    };
    if (existing) {
      const updated = await this.db.pushSubscription.updateMany({
        where: { endpoint: input.endpoint, userId },
        data: subscriptionData,
      });
      if (!updated.count) {
        const current = await this.db.pushSubscription.findUnique({
          where: { endpoint: input.endpoint },
          select: { userId: true },
        });
        if (current?.userId !== undefined && current.userId !== userId) {
          throw new ForbiddenException('This push subscription belongs to another user');
        }
        if (current) {
          throw new ConflictException('The push subscription changed while saving; retry the request');
        }
        await this.db.pushSubscription.create({
          data: { ...subscriptionData, userId, endpoint: input.endpoint },
        });
      }
      return;
    }
    await this.db.pushSubscription.create({
      data: { ...subscriptionData, userId, endpoint: input.endpoint },
    });
  }

  async removePushSubscription(userId: string, endpoint: string): Promise<void> {
    await this.db.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  async dispatchPendingPushNotifications(): Promise<number> {
    if (!this.vapidConfigured) {
      return 0;
    }

    const now = new Date();
    const staleClaim = new Date(now.getTime() - 5 * 60_000);
    const pending = await this.db.notification.findMany({
      where: {
        eventKey: { not: null },
        isRead: false,
        pushSentAt: null,
        pushAttempts: { lt: 5 },
        OR: [{ pushClaimedAt: null }, { pushClaimedAt: { lt: staleClaim } }],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    let delivered = 0;

    for (const notification of pending) {
      const claim = await this.db.notification.updateMany({
        where: {
          id: notification.id,
          pushSentAt: null,
          isRead: false,
          pushAttempts: { lt: 5 },
          OR: [{ pushClaimedAt: null }, { pushClaimedAt: { lt: staleClaim } }],
        },
        data: { pushClaimedAt: now, pushAttempts: { increment: 1 } },
      });
      if (!claim.count) {
        continue;
      }

      const subscriptions = await this.db.pushSubscription.findMany({
        where: { userId: notification.userId },
      });
      if (!subscriptions.length) {
        await this.db.notification.update({
          where: { id: notification.id },
          data: { pushSentAt: now, pushClaimedAt: null },
        });
        continue;
      }

      const route = this.notificationRoute(notification);
      const payload = JSON.stringify({
        notification: {
          title: notification.title,
          body: notification.message,
          icon: '/icons/icon-192x192.png',
          badge: '/icons/icon-192x192.png',
          tag: notification.id,
          data: {
            notificationId: notification.id,
            route,
            onActionClick: {
              default: { operation: 'navigateLastFocusedOrOpen', url: route },
            },
          },
        },
      });
      let retry = false;

      await Promise.all(subscriptions.map(async subscription => {
        try {
          await webPush.sendNotification({
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          }, payload);
        } catch (error) {
          const statusCode = this.pushErrorStatus(error);
          if (statusCode === 404 || statusCode === 410) {
            await this.db.pushSubscription.deleteMany({ where: { id: subscription.id } });
            return;
          }
          retry = true;
          this.logger.warn(`Push delivery failed for notification ${notification.id}`);
        }
      }));

      const exhausted = notification.pushAttempts + 1 >= 5;
      await this.db.notification.update({
        where: { id: notification.id },
        data: {
          pushClaimedAt: null,
          ...(!retry || exhausted ? { pushSentAt: now } : {}),
        },
      });
      if (!retry) {
        delivered += 1;
      }
    }

    return delivered;
  }

  async dispatchDueReminders(now = new Date()): Promise<number> {
    const localNow = this.localDateTime(now);
    const tomorrow = new Date(Date.UTC(
      localNow.year,
      localNow.month - 1,
      localNow.day + 1,
    ));
    const reminders = await this.db.reminder.findMany({
      where: { status: ReminderStatus.PENDING, reminderDate: { lt: tomorrow } },
      include: { participants: { select: { userId: true } } },
    });
    let dispatched = 0;

    for (const reminder of reminders) {
      const anchorDate = reminder.reminderDate.toISOString().slice(0, 10);
      if (!this.isOccurrenceDue(reminder.recurrence, anchorDate, localNow)) {
        continue;
      }
      if (reminder.reminderTime > localNow.time) {
        continue;
      }

      const eventDate = `${localNow.year}-${String(localNow.month).padStart(2, '0')}-${String(localNow.day).padStart(2, '0')}`;
      const recipientIds = [reminder.recipientId, ...reminder.participants.map(({ userId }) => userId)];
      await this.createForUsers(
        {
          title: 'Reminder due',
          message: reminder.title,
          type: NotificationType.REMINDER,
          priority: reminder.priority,
          sourceId: reminder.id,
          referenceId: reminder.id,
          resourceType: 'reminder',
          route: `/reminders/${reminder.id}`,
        },
        recipientIds,
        `reminder_due:${reminder.id}:${eventDate}`,
      );

      if (reminder.recurrence === ReminderRecurrence.ONCE ||
          reminder.recurrence === ReminderRecurrence.CUSTOM) {
        await this.db.reminder.updateMany({
          where: { id: reminder.id, status: ReminderStatus.PENDING },
          data: { status: ReminderStatus.TRIGGERED },
        });
      }
      dispatched += 1;
    }

    return dispatched;
  }

  private localDateTime(date: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.reminderTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find(value => value.type === type)?.value);
    return {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      time: `${String(part('hour')).padStart(2, '0')}:${String(part('minute')).padStart(2, '0')}`,
    };
  }

  private isOccurrenceDue(
    recurrence: ReminderRecurrence,
    anchorDate: string,
    localNow: { year: number; month: number; day: number },
  ): boolean {
    const [anchorYear, anchorMonth, anchorDay] = anchorDate.split('-').map(Number);
    const localDate = `${localNow.year}-${String(localNow.month).padStart(2, '0')}-${String(localNow.day).padStart(2, '0')}`;
    if (anchorDate > localDate) {
      return false;
    }

    switch (recurrence) {
      case ReminderRecurrence.DAILY:
        return true;
      case ReminderRecurrence.WEEKLY: {
        const anchor = Date.UTC(anchorYear, anchorMonth - 1, anchorDay);
        const today = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
        return Math.floor((today - anchor) / 86_400_000) % 7 === 0;
      }
      case ReminderRecurrence.MONTHLY:
        return anchorDay === localNow.day;
      case ReminderRecurrence.YEARLY:
        return anchorMonth === localNow.month && anchorDay === localNow.day;
      default:
        return anchorDate === localDate;
    }
  }

  private notificationRoute(notification: {
    route: string | null;
    resourceType: string | null;
    referenceId: string | null;
    sourceId: string | null;
  }): string {
    if (notification.route?.startsWith('/')) {
      return notification.route;
    }
    const id = notification.referenceId ?? notification.sourceId;
    if (id && ['task', 'meeting', 'reminder'].includes(notification.resourceType ?? '')) {
      return `/${notification.resourceType}s/${id}`;
    }
    return '/notifications';
  }

  private pushErrorStatus(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const status = error.statusCode;
      return typeof status === 'number' ? status : undefined;
    }
    return undefined;
  }

  private isPushServiceEndpoint(endpoint: string): boolean {
    let hostname: string;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') {
        return false;
      }
      hostname = url.hostname.toLowerCase();
    } catch {
      return false;
    }
    return hostname === 'fcm.googleapis.com' ||
      hostname.endsWith('.push.services.mozilla.com') ||
      hostname.endsWith('.push.apple.com') ||
      hostname.endsWith('.notify.windows.com') ||
      hostname.endsWith('.wns.windows.com');
  }

  setRead(id: string, userId: string, isRead: boolean) {
    return this.db.notification.updateMany({ where: { id, userId }, data: { isRead } });
  }

  markAllRead(userId: string) {
    return this.db.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
  }

  remove(id: string, userId: string) {
    return this.db.notification.deleteMany({ where: { id, userId } });
  }

  clearRead(userId: string) {
    return this.db.notification.deleteMany({ where: { userId, isRead: true } });
  }
}

import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createECDH } from 'node:crypto';
import {
  NotificationType,
  Priority,
  PushDeliveryStatus,
  ReminderRecurrence,
  ReminderStatus,
} from '@prisma/client';
import webPush from 'web-push';
import { PrismaService } from '../prisma.service';
import { PushJob, PushQueueService, QueueStats } from './push-queue.service';

export interface DispatchNotificationInput {
  title: string;
  message: string;
  type: NotificationType;
  priority?: Priority;
  actorId?: string;
  recipientIds: string[];
  sourceId?: string;
  referenceId?: string;
  resourceType?: string;
  route?: string;
  eventKey?: string;
}

export interface LegacyNotificationEvent {
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
  options?: Record<string, any>;
}

export interface PushPreferences {
  tasks: boolean;
  reminders: boolean;
  requests: boolean;
  meetings: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private vapidPublicKey: string;
  private vapidConfigured: boolean;
  private vapidStatusReason: string | null = null;
  private readonly reminderTimezone: string;
  private readonly frontendBaseUrl: string;
  private lastDueCheckTimestamp = 0;
  private isProcessingQueue = false;

  constructor(
    private readonly db: PrismaService,
    private readonly queueService: PushQueueService,
    private readonly config: ConfigService,
  ) {
    // Normalise env values: dashboards often keep surrounding quotes/whitespace or standard base64 padding.
    const clean = (value?: string) => (value ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
    const toBase64Url = (value: string) =>
      value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

    this.vapidPublicKey = toBase64Url(clean(config.get<string>('VAPID_PUBLIC_KEY')));
    const vapidPrivateKey = toBase64Url(clean(config.get<string>('VAPID_PRIVATE_KEY')));
    let vapidSubject = clean(config.get<string>('VAPID_SUBJECT'));
    if (vapidSubject && !/^(mailto:|https?:\/\/)/i.test(vapidSubject) && vapidSubject.includes('@')) {
      vapidSubject = `mailto:${vapidSubject}`;
    }
    this.reminderTimezone = clean(config.get<string>('REMINDER_TIMEZONE')) || 'Africa/Lagos';

    const origin = clean(config.get<string>('FRONTEND_ORIGIN')) || 'https://executive-reminder-frontend.vercel.app';
    this.frontendBaseUrl = clean(origin.split(',')[0]).replace(/\/+$/, '');

    const missing = [
      !this.vapidPublicKey && !vapidPrivateKey && 'VAPID_PUBLIC_KEY',
      !vapidPrivateKey && 'VAPID_PRIVATE_KEY',
      !vapidSubject && 'VAPID_SUBJECT',
    ].filter(Boolean);
    this.vapidConfigured = missing.length === 0;
    this.vapidStatusReason = missing.length ? `Missing environment variables: ${missing.join(', ')}` : null;

    if (this.vapidConfigured) {
      try {
        // Verify that VAPID_PUBLIC_KEY mathematically matches VAPID_PRIVATE_KEY on P-256;
        // web-push only checks byte lengths in setVapidDetails(), so a mismatched pair would
        // silently fail later at send time with 403 BadJwtToken from APNs / FCM.
        const curve = createECDH('prime256v1');
        curve.setPrivateKey(Buffer.from(vapidPrivateKey, 'base64url'));
        let derivedPub = curve.getPublicKey();
        if (derivedPub.length < 65) {
          derivedPub = Buffer.concat([Buffer.alloc(65 - derivedPub.length, 0), derivedPub]);
        }
        const derivedPublicKey = derivedPub.toString('base64url');
        if (this.vapidPublicKey !== derivedPublicKey) {
          this.logger.warn(
            'Configured VAPID_PUBLIC_KEY did not match VAPID_PRIVATE_KEY; using derived public key so APNs/FCM ES256 signatures verify.',
          );
          this.vapidPublicKey = derivedPublicKey;
        }

        webPush.setVapidDetails(vapidSubject, this.vapidPublicKey, vapidPrivateKey);
        this.logger.log(`Web push enabled (public key ${this.vapidPublicKey.slice(0, 8)}…)`);
      } catch (error) {
        this.vapidConfigured = false;
        this.vapidStatusReason = `Invalid VAPID configuration: ${error instanceof Error ? error.message : 'unknown error'}`;
        this.logger.error(
          'Failed to configure VAPID details. Push notifications will be unavailable until valid keys are configured.',
          error instanceof Error ? error.stack : undefined,
        );
      }
    } else {
      this.logger.warn(`Web push disabled. ${this.vapidStatusReason}`);
    }
  }

  async list(userId: string) {
    // Opportunistically check due reminders/meetings and drain any due retry jobs (throttled to 60s)
    await this.checkDueRemindersThrottled();
    return this.db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  // Canonical notification and push dispatcher
  async dispatchNotification(input: DispatchNotificationInput): Promise<void> {
    const {
      title,
      message,
      type,
      priority = Priority.MEDIUM,
      actorId,
      recipientIds,
      sourceId,
      referenceId,
      resourceType,
      route,
      eventKey: customEventKey,
    } = input;

    // 1. Exclude the actor who triggered the action and deduplicate
    const targetIds = [...new Set(recipientIds)].filter(id => Boolean(id) && id !== actorId);
    if (targetIds.length === 0) {
      return;
    }

    // 2. Resolve active recipients in the database
    let users: { id: string }[];
    try {
      users = await this.db.user.findMany({
        where: { id: { in: targetIds }, isActive: true },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `Unable to resolve recipients for ${type} notification`,
        error instanceof Error ? error.stack : undefined,
      );
      return;
    }

    if (users.length === 0) {
      return;
    }

    const defaultEventKey =
      customEventKey ||
      `${type.toLowerCase()}:${resourceType || 'event'}:${referenceId || sourceId || 'general'}:${Date.now()}`;
    const createdNotificationIds: string[] = [];

    // 3. Atomically create NotificationEvent and Notification for each recipient
    for (const user of users) {
      try {
        const created = await this.db.$transaction(async transaction => {
          const event = await transaction.notificationEvent.createMany({
            data: [{ userId: user.id, eventKey: defaultEventKey }],
            skipDuplicates: true,
          });
          if (!event.count) {
            return null;
          }
          return transaction.notification.create({
            data: {
              title,
              message,
              type,
              priority,
              userId: user.id,
              eventKey: defaultEventKey,
              sourceId,
              referenceId,
              resourceType,
              route,
            },
            select: { id: true, userId: true },
          });
        });

        if (created) {
          createdNotificationIds.push(created.id);
        }
      } catch (error) {
        this.logger.error(
          `Unable to persist ${type} notification for user ${user.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // 4. Deliver pushes before returning. On Vercel the function is frozen as soon as the
    //    response is sent, so fire-and-forget work (setImmediate) silently never runs.
    //    Retryable failures are handed to the Redis retry queue inside processJob.
    if (createdNotificationIds.length > 0) {
      await this.deliverNow(createdNotificationIds);
    }
  }

  private async deliverNow(notificationIds: string[]): Promise<void> {
    if (!this.vapidConfigured) {
      this.logger.warn(
        `Skipping push for ${notificationIds.length} notification(s): ${this.vapidStatusReason}`,
      );
      return;
    }
    await Promise.all(
      notificationIds.map(async notificationId => {
        try {
          await this.processJob({
            id: `inline_${notificationId}`,
            notificationId,
            attempt: 0,
            maxAttempts: 3,
            createdAt: Date.now(),
          });
        } catch (error) {
          this.logger.error(
            `Inline push delivery crashed for ${notificationId}; queuing for retry`,
            error instanceof Error ? error.stack : undefined,
          );
          await this.queueService.enqueue(notificationId).catch(() => undefined);
        }
      }),
    );
  }

  // Backward compatibility alias for single notification creation
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
      actorId?: string;
    },
    userId: string,
  ) {
    return this.dispatchNotification({
      title: data.title,
      message: data.message,
      type: data.type as NotificationType,
      priority: (data.priority as Priority) || Priority.MEDIUM,
      actorId: data.actorId,
      recipientIds: [userId],
      sourceId: data.sourceId,
      referenceId: data.referenceId,
      resourceType: data.resourceType,
      route: data.route,
    });
  }

  // Backward compatibility alias for existing service callers
  async createForUsers(
    data: LegacyNotificationEvent,
    recipientIds: string[],
    eventKey: string,
    actorId?: string,
  ): Promise<void> {
    return this.dispatchNotification({
      title: data.title,
      message: data.message,
      type: data.type,
      priority: data.priority,
      actorId,
      recipientIds,
      sourceId: data.sourceId,
      referenceId: data.referenceId,
      resourceType: data.resourceType,
      route: data.route,
      eventKey,
    });
  }

  async processQueue(batchSize = 25): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.isProcessingQueue) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    this.isProcessingQueue = true;

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      while (processed < batchSize) {
        const job = await this.queueService.popJob();
        if (!job) {
          break;
        }

        processed++;
        const result = await this.processJob(job);
        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }

    return { processed, succeeded, failed };
  }

  private async processJob(job: PushJob): Promise<{ success: boolean }> {
    if (!this.vapidConfigured) {
      return { success: false };
    }

    const notification = await this.db.notification.findUnique({
      where: { id: job.notificationId },
      include: {
        user: {
          include: {
            pushSubscriptions: true,
            notificationPreference: true,
          },
        },
      },
    });

    if (!notification || !notification.user) {
      return { success: true }; // Notification removed or obsolete
    }

    // Check user category preferences
    const preferenceCategory = this.notificationPreferenceCategory(notification);
    if (preferenceCategory && notification.user.notificationPreference) {
      const preferences = notification.user.notificationPreference;
      if (!preferences[preferenceCategory]) {
        await this.db.notification.update({
          where: { id: notification.id },
          data: { pushSentAt: new Date(), pushClaimedAt: null },
        });
        return { success: true };
      }
    }

    const subscriptions = notification.user.pushSubscriptions;
    if (!subscriptions.length) {
      await this.db.notification.update({
        where: { id: notification.id },
        data: { pushSentAt: new Date(), pushClaimedAt: null },
      });
      return { success: true };
    }

    const route = this.notificationRoute(notification);
    const iconUrl = `${this.frontendBaseUrl}/icons/icon-192x192.png`;
    const payload = JSON.stringify({
      notification: {
        title: notification.title,
        body: notification.message,
        icon: iconUrl,
        badge: iconUrl,
        tag: notification.id,
        timestamp: notification.createdAt.getTime(),
        data: {
          notificationId: notification.id,
          route,
          onActionClick: {
            default: { operation: 'navigateLastFocusedOrOpen', url: route },
          },
        },
      },
    });

    let hasRetryableFailure = false;
    let anyDelivered = false;

    // Send to each subscription with deduplication & APNs/FCM headers
    await Promise.all(
      subscriptions.map(async subscription => {
        const dedupeKey = `${notification.id}:${subscription.endpoint}`;
        const deviceType = this.detectDeviceType(subscription.endpoint);

        // Check deduplication lock to guarantee idempotency per device
        const acquired = await this.queueService.acquireLock(dedupeKey, 86400);
        if (!acquired && job.attempt > 0) {
          // Already successfully delivered to this endpoint in a prior attempt
          return;
        }

        // Standard Web Push headers only (RFC 8030). TTL + Urgency are honoured by FCM,
        // Apple (web.push.apple.com) and Mozilla; vendor-specific apns-* headers are not
        // part of Web Push and risk rejection by non-Apple push services.
        const requestOptions: webPush.RequestOptions = {
          TTL: 86400, // 24 hours
          urgency: 'high',
        };

        try {
          const res = await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            requestOptions,
          );

          anyDelivered = true;
          await this.db.pushDeliveryLog.create({
            data: {
              notificationId: notification.id,
              subscriptionId: subscription.id,
              userId: notification.userId,
              endpoint: subscription.endpoint,
              deviceType,
              status: PushDeliveryStatus.SENT,
              attempts: job.attempt + 1,
              httpStatus: res.statusCode || 201,
              sentAt: new Date(),
            },
          });
        } catch (error) {
          const statusCode = this.pushErrorStatus(error);

          // 404, 410 (Gone), or VAPID key mismatch means device unsubscribed or rotated keys
          if (statusCode === 404 || statusCode === 410 || this.isVapidKeyMismatch(error)) {
            await this.db.pushSubscription.deleteMany({ where: { id: subscription.id } });
            await this.db.pushDeliveryLog.create({
              data: {
                notificationId: notification.id,
                subscriptionId: subscription.id,
                userId: notification.userId,
                endpoint: subscription.endpoint,
                deviceType,
                status: PushDeliveryStatus.FAILED,
                attempts: job.attempt + 1,
                httpStatus: statusCode,
                errorDetails: `Invalid token pruned (${statusCode || 'VapidMismatch'})`,
              },
            });
            await this.queueService.releaseLock(dedupeKey);
            return;
          }

          // Retryable error (429 rate limit, 500, network error)
          hasRetryableFailure = true;
          await this.queueService.releaseLock(dedupeKey);

          await this.db.pushDeliveryLog.create({
            data: {
              notificationId: notification.id,
              subscriptionId: subscription.id,
              userId: notification.userId,
              endpoint: subscription.endpoint,
              deviceType,
              status: PushDeliveryStatus.FAILED,
              attempts: job.attempt + 1,
              httpStatus: statusCode,
              errorDetails: this.pushErrorDetails(error),
            },
          });
          this.logger.warn(
            `Push delivery failed for notification ${notification.id} on ${deviceType}: ${this.pushErrorDetails(error)}`,
          );
        }
      }),
    );

    if (hasRetryableFailure) {
      if (job.attempt < job.maxAttempts) {
        // Exponential backoff: attempt 0 -> 5s, attempt 1 -> 30s, attempt 2 -> 120s
        const backoffDelays = [5, 30, 120];
        const delaySeconds = backoffDelays[job.attempt] ?? 120;
        await this.queueService.scheduleRetry(job, delaySeconds, 'Retryable delivery failure');
        return { success: false };
      } else {
        // Max retries exhausted, send to DLQ
        await this.queueService.sendToDlq(job, 'Maximum retry attempts (3) exceeded');
        await this.db.notification.update({
          where: { id: notification.id },
          data: { pushClaimedAt: null },
        });
        return { success: false };
      }
    }

    // Success: mark sent
    await this.db.notification.update({
      where: { id: notification.id },
      data: { pushSentAt: new Date(), pushClaimedAt: null },
    });

    return { success: true };
  }

  private detectDeviceType(endpoint: string): 'ios' | 'android' | 'desktop' | 'unknown' {
    const lower = endpoint.toLowerCase();
    if (lower.includes('push.apple.com')) {
      return 'ios';
    }
    if (lower.includes('fcm.googleapis.com')) {
      return 'android';
    }
    if (lower.includes('mozilla.com') || lower.includes('windows.com') || lower.includes('wns.')) {
      return 'desktop';
    }
    return 'unknown';
  }

  async getPushPreferences(userId: string): Promise<PushPreferences> {
    const preferences = await this.db.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { tasks: true, reminders: true, requests: true, meetings: true },
    });
    return preferences;
  }

  async updatePushPreferences(
    userId: string,
    updates: Partial<PushPreferences>,
  ): Promise<PushPreferences> {
    const preferences = await this.db.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...updates },
      update: updates,
      select: { tasks: true, reminders: true, requests: true, meetings: true },
    });
    return preferences;
  }

  async suppressPendingPushNotifications(resourceType: string, referenceId: string): Promise<void> {
    try {
      await this.db.notification.updateMany({
        where: {
          resourceType,
          referenceId,
          eventKey: { not: null },
          isRead: false,
          pushSentAt: null,
        },
        data: { pushSentAt: new Date(), pushClaimedAt: null },
      });
    } catch (error) {
      this.logger.error(
        `Unable to suppress obsolete ${resourceType} pushes for ${referenceId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  pushConfig() {
    return {
      enabled: this.vapidConfigured,
      publicKey: this.vapidConfigured ? this.vapidPublicKey : null,
      // Non-secret diagnostic so a disabled server is debuggable from the browser.
      reason: this.vapidConfigured ? null : this.vapidStatusReason,
    };
  }

  async savePushSubscription(userId: string, input: PushSubscriptionInput): Promise<void> {
    if (!this.isPushServiceEndpoint(input.endpoint)) {
      throw new BadRequestException('The push service endpoint is not supported');
    }

    const subscriptionData = {
      userId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      expirationTime: input.expirationTime == null ? null : BigInt(input.expirationTime),
    };

    // Reassign endpoint to the currently authenticated user holding the browser's p256dh/auth keys
    // so switching accounts on the same iOS/Android/desktop device works seamlessly without 403s
    // and prevents notifications for a previous account from leaking to the active session.
    await this.db.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: subscriptionData,
      create: { ...subscriptionData, endpoint: input.endpoint },
    });
  }

  async sendTestPush(userId: string, delaySeconds = 0) {
    if (!this.vapidConfigured) {
      throw new BadRequestException(
        `Push notifications are not configured on the server yet${this.vapidStatusReason ? ` (${this.vapidStatusReason})` : ''}.`,
      );
    }

    const subscriptions = await this.db.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true },
    });

    if (subscriptions.length === 0) {
      throw new BadRequestException(
        'No active push subscription found for your account. Enable device notifications first.',
      );
    }

    const safeDelay = Math.max(0, Math.min(Math.floor(delaySeconds || 0), 6));
    if (safeDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, safeDelay * 1000));
    }

    const eventKey = `system:push_test:${userId}:${Date.now()}`;
    const notification = await this.db.notification.create({
      data: {
        title: 'Push notifications active',
        message:
          safeDelay > 0
            ? 'Background tray delivery verified on your device.'
            : 'Real-time native tray notifications are working on this device.',
        type: NotificationType.SYSTEM,
        priority: Priority.HIGH,
        userId,
        eventKey,
        resourceType: 'system',
        route: '/notifications',
      },
      select: { id: true },
    });

    await this.deliverNow([notification.id]);

    const deliveries = await this.db.pushDeliveryLog.findMany({
      where: { notificationId: notification.id },
      orderBy: { createdAt: 'desc' },
      select: {
        deviceType: true,
        status: true,
        httpStatus: true,
        errorDetails: true,
      },
    });

    return {
      sent: deliveries.some(d => d.status === PushDeliveryStatus.SENT),
      notificationId: notification.id,
      deviceCount: subscriptions.length,
      deliveries,
    };
  }

  async removePushSubscription(userId: string, endpoint: string): Promise<void> {
    await this.db.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  // Self-healing check for due reminders and meetings on user activity, throttled to 60s.
  // Awaited (not fire-and-forget) so it completes before Vercel freezes the function.
  private async checkDueRemindersThrottled(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDueCheckTimestamp < 60_000) {
      return;
    }
    this.lastDueCheckTimestamp = now;

    try {
      await this.dispatchDueReminders();
      await this.dispatchDueMeetingReminders();
      await this.processQueue(10);
    } catch (err) {
      this.logger.error('Throttled due reminders check error', err);
    }
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

  async dispatchDueMeetingReminders(now = new Date()): Promise<number> {
    const localNow = this.localDateTime(now);
    const today = `${localNow.year}-${String(localNow.month).padStart(2, '0')}-${String(localNow.day).padStart(2, '0')}`;
    const tomorrow = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1));
    const meetings = await this.db.meeting.findMany({
      where: {
        status: { in: ['SCHEDULED', 'RESCHEDULED'] },
        meetingDate: {
          gte: new Date(`${today}T00:00:00.000Z`),
          lt: tomorrow,
        },
      },
      include: {
        participants: { select: { userId: true } },
      },
    });
    const currentMinute = Number(localNow.time.slice(0, 2)) * 60 + Number(localNow.time.slice(3, 5));
    let dispatched = 0;

    for (const meeting of meetings) {
      const startTime = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(meeting.startTime);
      if (!startTime || meeting.meetingDate.toISOString().slice(0, 10) !== today) {
        continue;
      }
      const meetingMinute = Number(startTime[1]) * 60 + Number(startTime[2]);
      if (meetingMinute <= currentMinute || meetingMinute > currentMinute + 15) {
        continue;
      }

      await this.createForUsers(
        {
          title: 'Meeting starting soon',
          message: `"${meeting.title}" starts at ${meeting.startTime}.`,
          type: NotificationType.MEETING,
          priority: Priority.MEDIUM,
          sourceId: meeting.id,
          referenceId: meeting.id,
          resourceType: 'meeting',
          route: `/meetings/${meeting.id}`,
        },
        [meeting.organizerId, ...meeting.participants.map(({ userId }) => userId)],
        `meeting_reminder:${meeting.id}:${meeting.meetingDate.toISOString()}:${meeting.startTime}`,
      );
      dispatched += 1;
    }

    return dispatched;
  }

  // Delivery status tracking & logs
  async getDeliveryLogs(options: {
    userId?: string;
    notificationId?: string;
    status?: PushDeliveryStatus;
    limit?: number;
  }) {
    const { userId, notificationId, status, limit = 50 } = options;
    return this.db.pushDeliveryLog.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(notificationId ? { notificationId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      include: {
        notification: {
          select: {
            title: true,
            type: true,
            priority: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async getQueueStats(): Promise<QueueStats> {
    return this.queueService.getQueueStats();
  }

  async getDlqJobs(limit = 50) {
    return this.queueService.getDlqJobs(limit);
  }

  async retryDlqJob(job: PushJob) {
    return this.queueService.enqueue(job.notificationId);
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
    if (id && ['task', 'meeting', 'reminder', 'request'].includes(notification.resourceType ?? '')) {
      return `/${notification.resourceType}s/${id}`;
    }
    return '/notifications';
  }

  private notificationPreferenceCategory(
    notification: { resourceType: string | null; type: NotificationType },
  ): keyof PushPreferences | undefined {
    if (notification.resourceType === 'task' || notification.type === NotificationType.TASK_ASSIGNED ||
        notification.type === NotificationType.TASK_DUE || notification.type === NotificationType.TASK_OVERDUE) {
      return 'tasks';
    }
    if (notification.resourceType === 'reminder' || notification.type === NotificationType.REMINDER) {
      return 'reminders';
    }
    if (notification.resourceType === 'request' || notification.type === NotificationType.REQUEST) {
      return 'requests';
    }
    if (notification.resourceType === 'meeting' || notification.type === NotificationType.MEETING) {
      return 'meetings';
    }
    return undefined;
  }

  private pushErrorStatus(error: unknown): number | undefined {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const status = error.statusCode;
      return typeof status === 'number' ? status : undefined;
    }
    return undefined;
  }

  private pushErrorDetails(error: unknown): string {
    const statusCode = this.pushErrorStatus(error);
    const message = error instanceof Error ? error.message : 'Unknown push provider error';
    const body =
      typeof error === 'object' && error !== null && 'body' in error && typeof error.body === 'string'
        ? error.body.replace(/\s+/g, ' ').slice(0, 500)
        : undefined;
    return [
      statusCode === undefined ? undefined : `HTTP ${statusCode}`,
      message,
      body ? `Provider response: ${body}` : undefined,
    ].filter(Boolean).join('; ');
  }

  private isVapidKeyMismatch(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('body' in error)) {
      return false;
    }

    const body = error.body;
    if (typeof body !== 'string') {
      return false;
    }

    try {
      const response = JSON.parse(body) as { reason?: unknown };
      return response.reason === 'VapidPkHashMismatch';
    } catch {
      return false;
    }
  }

  private isPushServiceEndpoint(endpoint: string): boolean {
    try {
      const url = new URL(endpoint);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  setRead(id: string, userId: string, isRead: boolean) {
    return this.db.notification.updateMany({
      where: { id, userId },
      data: {
        isRead,
        ...(isRead ? { pushSentAt: new Date(), pushClaimedAt: null } : {}),
      },
    });
  }

  markAllRead(userId: string) {
    return this.db.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, pushSentAt: new Date(), pushClaimedAt: null },
    });
  }

  remove(id: string, userId: string) {
    return this.db.notification.deleteMany({ where: { id, userId } });
  }

  clearRead(userId: string) {
    return this.db.notification.deleteMany({ where: { userId, isRead: true } });
  }
}

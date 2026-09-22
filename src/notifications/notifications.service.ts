import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly db: PrismaService) {}
  list(userId: string) {
    return this.db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }
  create(data: { title: string; message: string; type: string; priority: string; sourceId?: string; referenceId?: string; resourceType?: string; route?: string }, userId: string) {
    return this.db.notification.create({ data: { ...data, userId, type: data.type as never, priority: data.priority as never } });
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

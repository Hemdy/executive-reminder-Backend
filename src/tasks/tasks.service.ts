import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
@Injectable() export class TasksService {
 constructor(private readonly db: PrismaService) {}
 private readonly userSelect = { id: true, title: true, firstName: true, middleName: true, lastName: true, email: true, role: true, roleId: true, department: true, avatarUrl: true, isActive: true } as const;
 private readonly taskInclude = { assignedTo: { select: this.userSelect }, createdBy: { select: this.userSelect }, participants: { include: { user: { select: this.userSelect } } } } as const;
 list(userId: string) { return this.db.task.findMany({ where: { OR: [{ assignedToId: userId }, { createdById: userId }, { participants: { some: { userId } } }] }, include: this.taskInclude, orderBy: { dueDate: 'asc' } }); }
 async create(dto: any, userId: string) {
  const { participantIds, ...taskData } = dto;
  const recipients = [...new Set<string>(participantIds?.length ? participantIds : [dto.assignedToId])];
  const task = await this.db.task.create({ data: { ...taskData, dueDate: new Date(dto.dueDate), createdById: userId, participants: { create: recipients.map(userId => ({ userId })) } }, include: this.taskInclude });
  const creator = await this.db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  await this.db.notification.createMany({ data: recipients.map(userId => ({ userId, title: 'New task assigned', message: `${creator?.firstName ?? 'A user'} ${creator?.lastName ?? ''} assigned you "${task.title}".${task.description ? ` ${task.description}` : ''}`, type: 'TASK_ASSIGNED' as const, priority: task.priority, sourceId: task.id, referenceId: task.id, resourceType: 'task', route: `/tasks/${task.id}` })) });
  return task;
 }
 async get(id: string) { const item = await this.db.task.findUnique({ where: { id }, include: this.taskInclude }); if (!item) throw new NotFoundException('Task not found'); return item; }
 async update(id: string, dto: any) {
  const { participantIds, ...taskData } = dto;
  if (participantIds) await this.db.taskParticipant.deleteMany({ where: { taskId: id } });
  return this.db.task.update({ where: { id }, data: { ...taskData, dueDate: new Date(dto.dueDate), ...(participantIds ? { participants: { create: [...new Set<string>(participantIds)].map(userId => ({ userId })) } } : {}) }, include: this.taskInclude });
 }
 remove(id: string) { return this.db.task.delete({ where: { id } }); }
 status(id: string, status: any) { return this.db.task.update({ where: { id }, data: { status } }); }
}

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const db = new PrismaClient();
const permissions = [
  ['read', 'tasks'], ['write', 'tasks'], ['read', 'reminders'], ['write', 'reminders'],
  ['read', 'requests'], ['write', 'requests'], ['read', 'meetings'], ['write', 'meetings'],
  ['read', 'notifications'], ['write', 'notifications'], ['users', 'admin'],
  ['view', 'roles'], ['create', 'roles'], ['edit', 'roles'], ['delete', 'roles'],
  ['view', 'users'], ['create', 'users'], ['edit', 'users'], ['delete', 'users'],
  ['view', 'dashboard'], ['view', 'settings'], ['edit', 'settings'],
] as const;

async function seed() {
  // Clear records that reference users before removing users and their roles.
  // This makes the seed safe to run against an existing database with foreign keys enabled.
  await db.$transaction([
    db.approvalRequest.deleteMany(),
    db.request.deleteMany(),
    db.meetingParticipant.deleteMany(),
    db.meeting.deleteMany(),
    db.notification.deleteMany(),
    db.reminder.deleteMany(),
    db.task.deleteMany(),
    db.user.deleteMany(),
    db.rolePermission.deleteMany(),
    db.role.deleteMany(),
  ]);

  const records = await Promise.all(permissions.map(([action, resource]) => db.permission.upsert({
    where: { action_resource: { action, resource } },
    update: { key: `${resource}:${action}` },
    create: { key: `${resource}:${action}`, action, resource },
  })));
  const role = await db.role.create({
    data: { name: 'CEO', description: 'Chief Executive Officer', isActive: true },
  });
  for (const permission of records) await db.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    update: {}, create: { roleId: role.id, permissionId: permission.id },
  });
  const hash = await bcrypt.hash('password123', 12);
  await db.user.create({
    data: {
      email: 'ceo@example.com',
      passwordHash: hash,
      firstName: 'Chief',
      lastName: 'Executive Officer',
      role: 'CEO',
      roleId: role.id,
      isActive: true,
    },
  });
  await db.$disconnect();
}
seed().catch(async (error: unknown) => { console.error(error); await db.$disconnect(); process.exitCode = 1; });

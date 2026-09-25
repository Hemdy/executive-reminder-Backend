import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createInitialAdmin } from './create-admin';
import { seededPermissions } from './permissions';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
const db = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {});

async function seed() {
  if (process.argv.includes('--create-admin')) {
    await createInitialAdmin(db, process.env.ADMIN_PASSWORD ?? '');
    return;
  }

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

  const records = await Promise.all(seededPermissions.map(([action, resource]) => db.permission.upsert({
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

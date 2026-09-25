import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { seededPermissions } from './permissions';

const adminEmail = 'admin@example.com';

export async function createInitialAdmin(db: PrismaClient, password: string): Promise<void> {
  const existingAdmin = await db.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) {
    console.info(`Admin account ${adminEmail} already exists; no changes were made.`);
    return;
  }

  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be set to a password of at least 8 characters.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const permissions = await Promise.all(seededPermissions.map(([action, resource]) =>
    db.permission.upsert({
      where: { action_resource: { action, resource } },
      update: { key: `${resource}:${action}` },
      create: { key: `${resource}:${action}`, action, resource },
    }),
  ));
  const role = await db.role.upsert({
    where: { name: 'ADMIN' },
    update: { isActive: true },
    create: { name: 'ADMIN', description: 'Administrator', isActive: true },
  });

  await Promise.all(permissions.map((permission) => db.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    update: {},
    create: { roleId: role.id, permissionId: permission.id },
  })));

  try {
    await db.user.create({
      data: {
        title: 'Dr',
        firstName: 'Chigozie',
        lastName: 'Oriaku',
        email: adminEmail,
        passwordHash,
        role: 'ADMIN',
        roleId: role.id,
        isActive: true,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrentAdmin = await db.user.findUnique({ where: { email: adminEmail } });
      if (concurrentAdmin) {
        console.info(`Admin account ${adminEmail} already exists; no changes were made.`);
        return;
      }
    }
    throw error;
  }

  console.info(`Created active ADMIN account ${adminEmail}.`);
}

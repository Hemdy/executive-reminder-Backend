import { PrismaService } from '../prisma.service';

export type ActivityResource = 'tasks' | 'reminders' | 'requests' | 'meetings';

const roleAccessSelect = {
  name: true,
  isActive: true,
  permissions: {
    select: {
      permission: {
        select: { resource: true, action: true },
      },
    },
  },
} as const;

export async function hasActivityWritePermission(
  db: PrismaService,
  userId: string,
  resource: ActivityResource,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      isActive: true,
      role: true,
      roleRef: { select: roleAccessSelect },
    },
  });
  if (!user?.isActive) {
    return false;
  }

  const role = user.roleRef ?? await db.role.findUnique({
    where: { name: user.role },
    select: roleAccessSelect,
  });
  if (!role?.isActive) {
    return false;
  }

  return role.name.toUpperCase() === 'ADMIN' ||
    role.permissions.some(({ permission }) =>
      permission.resource === resource && permission.action === 'write',
    );
}

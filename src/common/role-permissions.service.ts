import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const defaultNonAdminPermissions = [
  { action: 'write', resource: 'tasks' },
  { action: 'write', resource: 'meetings' },
  { action: 'write', resource: 'requests' },
  { action: 'write', resource: 'reminders' },
] as const;

export interface RolePermissionInput {
  action: string;
  resource: string;
}

@Injectable()
export class RolePermissionsService implements OnModuleInit {
  constructor(private readonly db: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const roles = await this.db.role.findMany({
      where: { name: { not: 'ADMIN' } },
      select: { id: true },
    });

    await Promise.all(roles.map(({ id }) => this.setPermissions(id)));
  }

  async setPermissions(roleId: string, inputs?: RolePermissionInput[]): Promise<void> {
    const role = await this.db.role.findUnique({
      where: { id: roleId },
      select: { name: true },
    });
    if (!role) throw new NotFoundException('Role not found');

    if (inputs !== undefined) {
      await this.db.rolePermission.deleteMany({ where: { roleId } });
    }

    const permissions = [
      ...(inputs ?? []),
      ...(role.name === 'ADMIN' ? [] : defaultNonAdminPermissions),
    ];

    for (const { action, resource } of permissions) {
      const permission = await this.db.permission.upsert({
        where: { action_resource: { action, resource } },
        update: { key: `${resource}:${action}` },
        create: { key: `${resource}:${action}`, action, resource },
      });
      await this.db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId: permission.id } },
        update: {},
        create: { roleId, permissionId: permission.id },
      });
    }
  }
}

import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const defaultNonAdminPermissions = [
  { action: 'write', resource: 'tasks' },
  { action: 'write', resource: 'meetings' },
  { action: 'write', resource: 'requests' },
  { action: 'write', resource: 'reminders' },
  { action: 'assign', resource: 'users' },
] as const;

const operationalReadPermissions = [
  { action: 'read', resource: 'tasks' },
  { action: 'read', resource: 'meetings' },
  { action: 'read', resource: 'requests' },
  { action: 'read', resource: 'reminders' },
] as const;

const directorPermissions = [
  { action: 'view', resource: 'roles' },
  { action: 'create', resource: 'roles' },
  { action: 'edit', resource: 'roles' },
  { action: 'delete', resource: 'roles' },
  { action: 'view', resource: 'users' },
  { action: 'create', resource: 'users' },
  { action: 'edit', resource: 'users' },
  { action: 'delete', resource: 'users' },
  { action: 'view', resource: 'settings' },
  { action: 'edit', resource: 'settings' },
] as const;

const operationalRoleNames = new Set([
  'COMPLIANCE',
  'COMPLIANCEOFFICER',
  'CORPORATESERVICES',
  'MANAGINGPARTNER',
]);

function normalizeRoleName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

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
      ...(operationalRoleNames.has(normalizeRoleName(role.name))
        ? operationalReadPermissions
        : []),
      ...(normalizeRoleName(role.name) === 'DIRECTOR' ? directorPermissions : []),
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

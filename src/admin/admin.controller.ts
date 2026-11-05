import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import {
  IsArray, IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { NotificationType, Priority, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard, RoleAdministrationGuard } from '../common/guards';
import { RolePermissionsService } from '../common/role-permissions.service';

class PermissionDto {
  @IsString() @IsNotEmpty() action!: string;
  @IsString() @IsNotEmpty() resource!: string;
}

class UserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsString() @IsNotEmpty() firstName!: string;
  @IsString() @IsNotEmpty() lastName!: string;
  @IsString() @IsNotEmpty() role!: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() middleName?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsString() roleId?: string;
}

class UpdateUserDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
  @IsOptional() @IsString() @IsNotEmpty() firstName?: string;
  @IsOptional() @IsString() @IsNotEmpty() lastName?: string;
  @IsOptional() @IsString() @IsNotEmpty() role?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() middleName?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsString() avatarUrl?: string;
  @IsOptional() @IsString() roleId?: string;
}

class ActiveDto {
  @IsBoolean() isActive!: boolean;
}

class RoleDto {
  @IsString() @IsNotEmpty() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PermissionDto)
  permissions?: PermissionDto[];
}

class UpdateRoleDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PermissionDto)
  permissions?: PermissionDto[];
}

const userSelect = {
  id: true, title: true, firstName: true, middleName: true, lastName: true,
  email: true, role: true, roleId: true, department: true, avatarUrl: true,
  isActive: true, createdAt: true, updatedAt: true,
} as const;

@Controller(['admin', ''])
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminController {
  constructor(
    private readonly db: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly rolePermissions: RolePermissionsService,
  ) {}

  @Get('users')
  @Permissions('users:view')
  users() {
    return this.db.user.findMany({
      where: { deletedAt: null },
      select: userSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('users/directory')
  @Permissions('users:assign')
  userDirectory() {
    return this.db.user.findMany({
      where: { isActive: true, deletedAt: null },
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        role: true,
        department: true,
        avatarUrl: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  }

  @Get('roles')
  @Permissions('roles:view')
  roles() {
    return this.db.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('users')
  @Permissions('users:create')
  async user(@Body() dto: UserDto) {
    const { password, roleId, ...data } = dto;
    const role = await this.resolveRole(roleId, dto.role);
    try {
      const newUser = await this.db.user.create({
        data: {
          ...data,
          email: data.email.trim().toLowerCase(),
          role: role.name,
          roleRef: { connect: { id: role.id } },
          passwordHash: await bcrypt.hash(password, 12),
        },
        select: userSelect,
      });

      await this.notifications.dispatchNotification({
        title: 'Welcome to Executive Reminder',
        message: `Your account has been created with the ${role.name} role.`,
        type: NotificationType.SYSTEM,
        priority: Priority.HIGH,
        recipientIds: [newUser.id],
        route: '/dashboard',
      });

      return newUser;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A user with this email address already exists');
      }
      throw error;
    }
  }

  @Post('roles')
  @UseGuards(RoleAdministrationGuard)
  @Permissions('roles:create')
  async role(@Body() dto: RoleDto) {
    const role = await this.db.role.upsert({
      where: { name: dto.name },
      update: { description: dto.description },
      create: { name: dto.name, description: dto.description },
    });
    await this.rolePermissions.setPermissions(role.id, dto.permissions);
    return this.getRole(role.id);
  }

  @Patch('users/:id')
  @Permissions('users:edit')
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    const existingUser = await this.requireUser(id);
    const { password, roleId, ...data } = dto;
    const role = dto.role !== undefined || roleId !== undefined
      ? await this.resolveRole(roleId, dto.role)
      : undefined;
    try {
      const updatedUser = await this.db.user.update({
        where: { id },
        data: {
          ...data,
          ...(data.email ? { email: data.email.trim().toLowerCase() } : {}),
          ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}),
          ...(role ? {
            role: role.name,
            roleRef: { connect: { id: role.id } },
          } : {}),
        },
        select: userSelect,
      });

      if (role && role.name !== existingUser.role) {
        await this.notifications.dispatchNotification({
          title: 'Account Role Updated',
          message: `Your role has been updated from ${existingUser.role} to ${role.name}.`,
          type: NotificationType.SYSTEM,
          priority: Priority.HIGH,
          recipientIds: [id],
          route: '/dashboard',
        });
      }

      return updatedUser;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A user with this email address already exists');
      }
      throw error;
    }
  }

  @Patch('users/:id/active')
  @Patch('users/:id/status')
  @Permissions('users:edit')
  async setUserActive(@Param('id') id: string, @Body() dto: ActiveDto) {
    const updated = await this.userTransaction(async tx => {
      const user = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          isActive: true,
          role: true,
          roleRef: { select: { name: true } },
        },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (user.isActive && !dto.isActive) {
        await this.ensureNotLastActiveAdministrator(tx, user);
      }
      return tx.user.update({
        where: { id },
        data: { isActive: dto.isActive },
        select: userSelect,
      });
    });
    if (dto.isActive) {
      await this.notifications.dispatchNotification({
        title: 'Account Re-activated',
        message: 'Your account has been re-activated by an administrator.',
        type: NotificationType.SYSTEM,
        priority: Priority.HIGH,
        recipientIds: [id],
        route: '/dashboard',
      });
    }
    return updated;
  }

  @Delete('users/:id')
  @Permissions('users:delete')
  async deleteUser(@Param('id') id: string) {
    await this.userTransaction(async tx => {
      const user = await tx.user.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          isActive: true,
          role: true,
          roleRef: { select: { name: true } },
        },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      await this.ensureNotLastActiveAdministrator(tx, user);
      await tx.user.update({
        where: { id },
        data: { isActive: false, deletedAt: new Date() },
      });
    });
    return { id, deleted: true, softDeleted: true };
  }

  @Put('roles/:id')
  @Patch('roles/:id')
  @UseGuards(RoleAdministrationGuard)
  @Permissions('roles:edit')
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    await this.requireRole(id);
    await this.db.role.update({ where: { id }, data: { name: dto.name, description: dto.description } });
    await this.rolePermissions.setPermissions(id, dto.permissions);
    return this.getRole(id);
  }

  @Patch('roles/:id/active')
  @Patch('roles/:id/status')
  @UseGuards(RoleAdministrationGuard)
  @Permissions('roles:edit')
  async setRoleActive(@Param('id') id: string, @Body() dto: ActiveDto) {
    await this.requireRole(id);
    await this.db.role.update({ where: { id }, data: { isActive: dto.isActive } });
    return this.getRole(id);
  }

  @Delete('roles/:id')
  @UseGuards(RoleAdministrationGuard)
  @Permissions('roles:delete')
  async deleteRole(@Param('id') id: string) {
    await this.requireRole(id);
    await this.db.$transaction([
      this.db.user.updateMany({ where: { roleId: id }, data: { roleId: null } }),
      this.db.role.delete({ where: { id } }),
    ]);
    return { id, deleted: true };
  }

  private async requireUser(id: string) {
    const user = await this.db.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async ensureNotLastActiveAdministrator(
    tx: Prisma.TransactionClient,
    user: { isActive: boolean; role: string; roleRef: { name: string } | null },
  ): Promise<void> {
    const isAdministrator =
      user.roleRef?.name.toUpperCase() === 'ADMIN' || user.role.toUpperCase() === 'ADMIN';
    if (!user.isActive || !isAdministrator) {
      return;
    }

    const activeUsers = await tx.user.findMany({
      where: { isActive: true, deletedAt: null },
      select: { role: true, roleRef: { select: { name: true } } },
    });
    const activeAdministratorCount = activeUsers.filter(candidate =>
      candidate.roleRef?.name.toUpperCase() === 'ADMIN' ||
      candidate.role.toUpperCase() === 'ADMIN'
    ).length;

    if (activeAdministratorCount <= 1) {
      throw new ConflictException('The last active administrator cannot be deactivated or deleted');
    }
  }

  private async userTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('User status changed concurrently. Please try again.');
      }
      throw error;
    }
  }

  private async requireRole(id: string) {
    const role = await this.db.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async resolveRole(roleId?: string, roleName?: string) {
    const role = roleId
      ? await this.db.role.findUnique({ where: { id: roleId } })
      : roleName
        ? await this.db.role.findUnique({ where: { name: roleName } })
        : null;
    if (!role) {
      throw new BadRequestException('A valid active role is required');
    }
    if (!role.isActive) {
      throw new BadRequestException('The selected role is inactive');
    }
    return role;
  }

  private getRole(id: string) {
    return this.db.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
  }

}

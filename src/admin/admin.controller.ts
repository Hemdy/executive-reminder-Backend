import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import {
  IsArray, IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
import { Permissions } from '../common/decorators';
import { JwtAuthGuard, PermissionsGuard } from '../common/guards';

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
  constructor(private readonly db: PrismaService) {}

  @Get('users')
  @Permissions('users:view')
  users() {
    return this.db.user.findMany({ select: userSelect, orderBy: { createdAt: 'desc' } });
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
    return this.db.user.create({
      data: {
        ...data,
        email: data.email.trim().toLowerCase(),
        role: role.name,
        roleRef: { connect: { id: role.id } },
        passwordHash: await bcrypt.hash(password, 12),
      },
      select: userSelect,
    });
  }

  @Post('roles')
  @Permissions('roles:create')
  async role(@Body() dto: RoleDto) {
    const role = await this.db.role.upsert({
      where: { name: dto.name },
      update: { description: dto.description },
      create: { name: dto.name, description: dto.description },
    });
    await this.setPermissions(role.id, dto.permissions);
    return this.getRole(role.id);
  }

  @Patch('users/:id')
  @Permissions('users:edit')
  async updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    await this.requireUser(id);
    const { password, roleId, ...data } = dto;
    const role = dto.role !== undefined || roleId !== undefined
      ? await this.resolveRole(roleId, dto.role)
      : undefined;
    return this.db.user.update({
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
  }

  @Patch('users/:id/active')
  @Patch('users/:id/status')
  @Permissions('users:edit')
  async setUserActive(@Param('id') id: string, @Body() dto: ActiveDto) {
    await this.requireUser(id);
    return this.db.user.update({ where: { id }, data: { isActive: dto.isActive }, select: userSelect });
  }

  @Delete('users/:id')
  @Permissions('users:delete')
  async deleteUser(@Param('id') id: string) {
    await this.requireUser(id);
    await this.db.user.delete({ where: { id } });
    return { id, deleted: true };
  }

  @Put('roles/:id')
  @Patch('roles/:id')
  @Permissions('roles:edit')
  async updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    await this.requireRole(id);
    await this.db.role.update({ where: { id }, data: { name: dto.name, description: dto.description } });
    if (dto.permissions !== undefined) await this.setPermissions(id, dto.permissions);
    return this.getRole(id);
  }

  @Patch('roles/:id/active')
  @Patch('roles/:id/status')
  @Permissions('roles:edit')
  async setRoleActive(@Param('id') id: string, @Body() dto: ActiveDto) {
    await this.requireRole(id);
    await this.db.role.update({ where: { id }, data: { isActive: dto.isActive } });
    return this.getRole(id);
  }

  @Delete('roles/:id')
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
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
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

  private async setPermissions(roleId: string, inputs?: PermissionDto[]) {
    if (inputs === undefined) return;
    await this.db.rolePermission.deleteMany({ where: { roleId } });
    for (const input of inputs) {
      const key = `${input.resource}:${input.action}`;
      const permission = await this.db.permission.upsert({
        where: { action_resource: { action: input.action, resource: input.resource } },
        update: { key },
        create: { key, action: input.action, resource: input.resource },
      });
      await this.db.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    }
  }
}

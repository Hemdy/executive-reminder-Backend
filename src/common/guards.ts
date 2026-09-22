import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma.service';
import { PERMISSIONS_KEY } from './decorators';
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    if (!required.length) return true;
    const user = context.switchToHttp().getRequest().user as { id: string };
    if (!user?.id) throw new UnauthorizedException();
    const record = await this.prisma.user.findUnique({ where: { id: user.id }, include: { roleRef: { include: { permissions: { include: { permission: true } } } } } });
    const granted = record?.isActive && record.roleRef?.isActive
      ? record.roleRef.permissions.map(({ permission }) => `${permission.resource}:${permission.action}`)
      : [];
    if (!required.every((permission) => granted.includes(permission))) throw new ForbiddenException('Missing required permission');
    return true;
  }
}

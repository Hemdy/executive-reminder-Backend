import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma.service';
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: { roleRef: { include: { permissions: { include: { permission: true } } } } },
    });
    const assignedRole = user?.roleRef ?? (user
      ? await this.prisma.role.findUnique({
          where: { name: user.role },
          include: { permissions: { include: { permission: true } } },
        })
      : null);
    if (
      !user?.isActive ||
      !assignedRole?.isActive ||
      !(await bcrypt.compare(password, user.passwordHash))
    )
      throw new UnauthorizedException('Invalid credentials');
    const permissions =
      assignedRole.permissions.map((p) => `${p.permission.resource}:${p.permission.action}`);
    return {
      accessToken: await this.jwt.signAsync({
        sub: user.id,
        email: user.email,
        role: user.role,
        permissions,
      }),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions,
        isActive: user.isActive,
      },
    };
  }
  async validate(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { roleRef: true },
    });
    const assignedRole = user?.roleRef ?? (user
      ? await this.prisma.role.findUnique({ where: { name: user.role } })
      : null);
    if (!user?.isActive || !assignedRole?.isActive) throw new UnauthorizedException();
    return user;
  }
}

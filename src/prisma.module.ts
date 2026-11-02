import { Global, Module } from '@nestjs/common';
import { JwtAuthGuard, PermissionsGuard, RoleAdministrationGuard } from './common/guards';
import { RolePermissionsService } from './common/role-permissions.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    PrismaService,
    RolePermissionsService,
    JwtAuthGuard,
    PermissionsGuard,
    RoleAdministrationGuard,
  ],
  exports: [
    PrismaService,
    RolePermissionsService,
    JwtAuthGuard,
    PermissionsGuard,
    RoleAdministrationGuard,
  ],
})
export class PrismaModule {}

import { Global, Module } from '@nestjs/common';
import { RolePermissionsService } from './common/role-permissions.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, RolePermissionsService],
  exports: [PrismaService, RolePermissionsService],
})
export class PrismaModule {}

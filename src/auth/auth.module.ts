import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
@Module({ imports: [ConfigModule, PassportModule, JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_SECRET'), signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '1d') } }) })], controllers: [AuthController], providers: [AuthService, JwtStrategy, PrismaService], exports: [AuthService, JwtModule, PassportModule] })
export class AuthModule {}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from '../src/app.module';

let cached: express.Express | undefined;
let bootstrapPromise: Promise<express.Express> | undefined;

async function createApp(): Promise<express.Express> {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));
  await app.init();

  return server;
}

export default async function handler(req: express.Request, res: express.Response) {
  if (!cached) {
    bootstrapPromise ??= createApp();
    cached = await bootstrapPromise;
  }

  return cached(req, res);
}

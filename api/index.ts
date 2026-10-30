import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from '../src/app.module';
import { isAllowedOrigin } from '../src/common/cors';

let cached: express.Express | undefined;
let bootstrapPromise: Promise<express.Express> | undefined;

async function createApp(): Promise<express.Express> {
  const server = express();
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition', 'Content-Length'],
    credentials: true,
    optionsSuccessStatus: 204,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();

  return server;
}

function applyCorsHeaders(req: express.Request, res: express.Response): boolean {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin);
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  }
  res.setHeader('Vary', 'Origin');
  return Boolean(allowed);
}

export default async function handler(req: express.Request, res: express.Response) {
  const originAllowed = applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    if (!originAllowed) {
      res.status(403).end();
      return;
    }
    res.status(204).end();
    return;
  }

  if (!cached) {
    bootstrapPromise ??= createApp();
    try {
      cached = await bootstrapPromise;
    } catch (error) {
      bootstrapPromise = undefined;
      console.error('Unable to initialize the NestJS API function.', error);
      applyCorsHeaders(req, res);
      if (!res.headersSent) {
        res.status(503).json({ message: 'The API is temporarily unavailable.' });
      }
      return;
    }
  }

  return cached(req, res);
}

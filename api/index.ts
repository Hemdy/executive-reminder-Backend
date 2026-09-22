import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { AppModule } from '../src/app.module';
let cached: express.Express | undefined;
export default async function handler(req: express.Request, res: express.Response) {
  if (!cached) {
    const server = express();
    const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
    app.enableCors({ origin: process.env.FRONTEND_ORIGIN, credentials: true });
    await app.init();
    cached = server;
  }
  cached(req, res);
}

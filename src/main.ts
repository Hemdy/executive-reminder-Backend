import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  // app.enableCors({
  //   origin:
  //     process.env.FRONTEND_ORIGIN ??
  //     "https://executive-reminder-frontend.vercel.app",
  //   credentials: true,
  // });

  app.enableCors({
  origin: [
    'https://executive-reminder-frontend.vercel.app',
    'http://localhost:4200',
  ],
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();

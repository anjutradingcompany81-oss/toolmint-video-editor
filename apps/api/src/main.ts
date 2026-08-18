import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(cookieParser());

  app.enableCors({
    origin: config.get<string>("WEB_APP_URL", "http://localhost:3000"),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Most PaaS hosts (Railway, Render, ...) inject PORT and require the app to
  // bind to it; API_PORT is what local dev / .env.example use instead.
  const port = config.get<number>("PORT") ?? config.get<number>("API_PORT", 4000);
  await app.listen(port);
  console.log(`ToolMint API listening on http://localhost:${port}`);
}

bootstrap();

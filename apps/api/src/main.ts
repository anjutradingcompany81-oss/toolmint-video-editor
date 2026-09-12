import "reflect-metadata";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { buildAllowedOrigins, isAllowedOrigin } from "./cors-origin.util";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(cookieParser());

  // Accepts both the bare-domain and "www." form of whichever host is
  // configured — landing on the one CORS doesn't recognize otherwise
  // breaks every API call with no visible reason on the page itself
  // (confirmed live: toolmint.co.in vs. www.toolmint.co.in).
  const allowedOrigins = buildAllowedOrigins(config.get<string>("WEB_APP_URL", "http://localhost:3000"));
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, isAllowedOrigin(origin, allowedOrigins));
    },
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
  console.log(`ProCut API listening on http://localhost:${port}`);
}

bootstrap();

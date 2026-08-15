import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { MailModule } from "./mail/mail.module";
import { UsersModule } from "./users/users.module";
import { AuthModule } from "./auth/auth.module";
import { StorageModule } from "./storage/storage.module";
import { ProjectsModule } from "./projects/projects.module";
import { MediaModule } from "./media/media.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env"],
    }),
    PrismaModule,
    MailModule,
    StorageModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ProjectsModule,
    MediaModule,
  ],
})
export class AppModule {}

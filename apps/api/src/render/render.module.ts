import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { ProjectsModule } from "../projects/projects.module";
import { RenderController } from "./render.controller";
import { RenderService } from "./render.service";
import { RenderProcessor } from "./render.processor";
import { RENDER_QUEUE, RENDER_QUEUE_NAME, REDIS_CONNECTION } from "./render.constants";

@Module({
  imports: [ProjectsModule],
  controllers: [RenderController],
  providers: [
    RenderService,
    RenderProcessor,
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      // BullMQ requires this specific option on any connection it uses.
      useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>("REDIS_URL"), { maxRetriesPerRequest: null }),
    },
    {
      provide: RENDER_QUEUE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(RENDER_QUEUE_NAME, { connection }),
    },
  ],
})
export class RenderModule {}

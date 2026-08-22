import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { ProjectsModule } from "../projects/projects.module";
import { MediaProbeService } from "../media/media-probe.service";
import { VoiceOverController } from "./voice-over.controller";
import { VoiceOverService } from "./voice-over.service";
import { VoiceOverProcessor } from "./voice-over.processor";
import { TtsRegistryService } from "./tts/tts-registry.service";
import { LocalTtsProvider } from "./tts/local-tts.provider";
import { ElevenLabsTtsProvider } from "./tts/elevenlabs-tts.provider";
import { VOICE_OVER_QUEUE, VOICE_OVER_QUEUE_NAME, VOICE_OVER_REDIS_CONNECTION } from "./voice-over.constants";

@Module({
  imports: [ProjectsModule],
  controllers: [VoiceOverController],
  providers: [
    VoiceOverService,
    VoiceOverProcessor,
    TtsRegistryService,
    LocalTtsProvider,
    ElevenLabsTtsProvider,
    // Provided directly rather than by importing MediaModule: MediaModule
    // doesn't export it, and importing the whole module here just to
    // reach one stateless helper would drag its controller in with it.
    MediaProbeService,
    {
      provide: VOICE_OVER_REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>("REDIS_URL"), { maxRetriesPerRequest: null }),
    },
    {
      provide: VOICE_OVER_QUEUE,
      inject: [VOICE_OVER_REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(VOICE_OVER_QUEUE_NAME, { connection }),
    },
  ],
})
export class VoiceOverModule {}

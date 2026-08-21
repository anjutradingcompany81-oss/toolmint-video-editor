import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { ProjectsModule } from "../projects/projects.module";
import { VoiceScanController } from "./voice-scan.controller";
import { VoiceScanService } from "./voice-scan.service";
import { VoiceScanProcessor } from "./voice-scan.processor";
import { WhisperService } from "./audio-analysis/whisper.service";
import { DiarizationService } from "./audio-analysis/diarization.service";
import { VOICE_SCAN_QUEUE, VOICE_SCAN_QUEUE_NAME, VOICE_REDIS_CONNECTION } from "./voice.constants";

@Module({
  imports: [ProjectsModule],
  controllers: [VoiceScanController],
  providers: [
    VoiceScanService,
    VoiceScanProcessor,
    WhisperService,
    DiarizationService,
    {
      provide: VOICE_REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>("REDIS_URL"), { maxRetriesPerRequest: null }),
    },
    {
      provide: VOICE_SCAN_QUEUE,
      inject: [VOICE_REDIS_CONNECTION],
      useFactory: (connection: Redis) => new Queue(VOICE_SCAN_QUEUE_NAME, { connection }),
    },
  ],
})
export class VoiceModule {}

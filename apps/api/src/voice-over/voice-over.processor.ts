import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type Redis from "ioredis";
import ffmpegPath from "ffmpeg-static";
import { MediaAssetKind, MediaAssetStatus, Prisma, VoiceOverStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MediaProbeService } from "../media/media-probe.service";
import { sanitizeFileName } from "../media/media.constants";
import { TtsRegistryService } from "./tts/tts-registry.service";
import { VOICE_OVER_QUEUE_NAME, VOICE_OVER_REDIS_CONNECTION, VOICE_OVER_SAMPLE_RATE } from "./voice-over.constants";
import { encodeWav, mixVoiceOverTrack, type SynthesizedLine } from "./voice-over-mix.util";
import type { VoiceOverLineDto } from "./dto/voice-over.dto";

// mp3 rather than the wav the mixer produces: a 30-minute narration track
// is ~86MB as 24kHz PCM and roughly a tenth of that as mp3, and every
// consumer of it (the browser preview, the render pipeline) decodes mp3
// natively.
const MP3_BITRATE = "128k";

@Injectable()
export class VoiceOverProcessor implements OnModuleDestroy {
  private readonly logger = new Logger("VoiceOverProcessor");
  private readonly worker: Worker<{ voiceOverJobId: string }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly probe: MediaProbeService,
    private readonly registry: TtsRegistryService,
    @Inject(VOICE_OVER_REDIS_CONNECTION) connection: Redis,
  ) {
    // Concurrency 1: local synthesis loads a multi-hundred-megabyte model
    // into this same process, and running several at once on a CPU-only
    // box makes each one slower rather than finishing them sooner.
    this.worker = new Worker(VOICE_OVER_QUEUE_NAME, (job) => this.process(job), { connection, concurrency: 1 });
    this.worker.on("failed", (job, err) => this.logger.error(`Voice over ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  private async process(job: Job<{ voiceOverJobId: string }>): Promise<void> {
    const voiceOverJob = await this.prisma.voiceOverJob.findUnique({ where: { id: job.data.voiceOverJobId } });
    if (!voiceOverJob) return;

    const workDir = await mkdtemp(join(tmpdir(), "procut-voiceover-"));
    try {
      const provider = this.registry.get(voiceOverJob.providerId);
      if (!provider) throw new Error(`Voice provider "${voiceOverJob.providerId}" is no longer available on this server`);
      if (provider.readiness() !== "READY") {
        const missing = provider.requiredEnvVar ? ` (${provider.requiredEnvVar} is not set)` : "";
        throw new Error(`${provider.label} is not configured on this server${missing}`);
      }

      const lines = voiceOverJob.lines as unknown as VoiceOverLineDto[];
      await this.setStage(voiceOverJob.id, VoiceOverStatus.SYNTHESIZING, `Generating speech for ${lines.length} line(s)`, 5);

      const synthesized: SynthesizedLine[] = [];
      for (const [index, line] of lines.entries()) {
        if (await this.isCancelled(voiceOverJob.id)) {
          await this.markCancelled(voiceOverJob.id);
          return;
        }

        let result;
        try {
          result = await provider.synthesize({ text: line.text, voiceId: line.voiceId });
        } catch (err) {
          // Name the line that failed. A bare "synthesis failed" on a
          // 40-line script gives the user nothing to act on.
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Couldn't speak line ${index + 1} ("${line.text.slice(0, 40)}"): ${reason}`);
        }

        synthesized.push({ lineId: line.id, startMs: line.startMs, samples: result.samples, sampleRate: result.sampleRate });

        // Synthesis dominates the runtime, so the bar spends 5-85% here
        // and leaves the rest for mixing, encoding and upload.
        await this.setStage(
          voiceOverJob.id,
          VoiceOverStatus.SYNTHESIZING,
          `Generating speech (${index + 1} of ${lines.length})`,
          5 + Math.round(((index + 1) / lines.length) * 80),
        );
      }

      if (await this.isCancelled(voiceOverJob.id)) {
        await this.markCancelled(voiceOverJob.id);
        return;
      }
      await this.setStage(voiceOverJob.id, VoiceOverStatus.MIXING, "Mixing voice over track", 88);

      const mix = mixVoiceOverTrack(synthesized, VOICE_OVER_SAMPLE_RATE);
      if (mix.clipped) {
        this.logger.warn(`Voice over ${voiceOverJob.id} clipped - overlapping lines summed past full scale`);
      }

      const wavPath = join(workDir, "voice-over.wav");
      const mp3Path = join(workDir, "voice-over.mp3");
      await writeFile(wavPath, encodeWav(mix.samples, mix.sampleRate));
      await this.encodeMp3(wavPath, mp3Path);

      await this.setStage(voiceOverJob.id, VoiceOverStatus.MIXING, "Saving voice over to your media", 94);
      const assetId = await this.registerAsset(voiceOverJob.projectId, voiceOverJob.requestedById, mp3Path);

      await this.prisma.voiceOverJob.update({
        where: { id: voiceOverJob.id },
        data: {
          status: VoiceOverStatus.COMPLETED,
          stageLabel: "Ready",
          progress: 100,
          resultMediaAssetId: assetId,
          lineTimings: mix.timings as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice over generation failed";
      this.logger.error(`Voice over ${voiceOverJob.id} failed: ${message}`);
      await this.prisma.voiceOverJob.update({
        where: { id: voiceOverJob.id },
        data: { status: VoiceOverStatus.FAILED, errorMessage: message, stageLabel: null, completedAt: new Date() },
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Registers the mixed track as an ordinary project MediaAsset, so it
  // reaches the timeline, the preview and the export through exactly the
  // same code paths as an uploaded audio file - no special-case clip
  // kind and no parallel preview/export handling to keep in sync.
  // Probing it here (rather than leaving duration null) is what lets the
  // editor place it as a correctly-sized clip and draw its waveform.
  private async registerAsset(projectId: string, userId: string, mp3Path: string): Promise<string> {
    const buffer = await readFile(mp3Path);

    const assetId = randomUUID();
    const fileName = sanitizeFileName("Voice over.mp3");
    const storageKey = `projects/${projectId}/${assetId}/${fileName}`;
    await this.storage.putObjectFromFile(storageKey, mp3Path, "audio/mpeg");

    let probed: { durationMs: number | null; waveformPeaks: number[] | null } = { durationMs: null, waveformPeaks: null };
    try {
      probed = await this.probe.probe(buffer, "mp3", true);
    } catch (err) {
      this.logger.warn(`Probing generated voice over failed: ${err instanceof Error ? err.message : err}`);
    }

    await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        projectId,
        kind: MediaAssetKind.AUDIO,
        status: MediaAssetStatus.READY,
        originalName: "Voice over.mp3",
        storageKey,
        mimeType: "audio/mpeg",
        byteSize: buffer.length,
        durationMs: probed.durationMs,
        hasAudio: true,
        waveformPeaks: probed.waveformPeaks === null ? Prisma.JsonNull : probed.waveformPeaks,
        uploadedById: userId,
      },
    });
    return assetId;
  }

  private encodeMp3(inputPath: string, outputPath: string): Promise<void> {
    if (!ffmpegPath) return Promise.reject(new Error("No ffmpeg binary available for this platform/architecture"));
    const binaryPath = ffmpegPath;
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, ["-y", "-loglevel", "error", "-i", inputPath, "-c:a", "libmp3lame", "-b:a", MP3_BITRATE, outputPath]);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`))));
    });
  }

  private async isCancelled(jobId: string): Promise<boolean> {
    const row = await this.prisma.voiceOverJob.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
    return row?.cancelRequested ?? false;
  }

  private async markCancelled(jobId: string): Promise<void> {
    await this.prisma.voiceOverJob.update({
      where: { id: jobId },
      data: { status: VoiceOverStatus.CANCELLED, stageLabel: null, completedAt: new Date() },
    });
  }

  private async setStage(jobId: string, status: VoiceOverStatus, stageLabel: string, progress: number): Promise<void> {
    await this.prisma.voiceOverJob.update({ where: { id: jobId }, data: { status, stageLabel, progress } });
  }
}

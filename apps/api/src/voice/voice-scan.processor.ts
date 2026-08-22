import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type Redis from "ioredis";
import { ConfidenceBucket, CorrectionMode, Prisma, RepetitionKind, VoiceScanScope, VoiceScanStatus, type MediaAsset } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compositionSchema, type Clip } from "../projects/composition.schema";
import { VOICE_SCAN_QUEUE_NAME, VOICE_REDIS_CONNECTION } from "./voice.constants";
import { extractPcm } from "./audio-analysis/pcm-extract.util";
import { computeMfccFingerprint, computeEnergyEnvelope, estimatePitchHz } from "./audio-analysis/audio-features.util";
import { detectSpeechRegions } from "./audio-analysis/voice-activity.util";
import { WhisperService, WHISPER_SAMPLE_RATE } from "./audio-analysis/whisper.service";
import { DiarizationService, speakerForRange, type DiarizationSegment } from "./audio-analysis/diarization.service";
import { detectRepetitions, SENSITIVITY_PRESETS, type SensitivityThresholds, type TranscriptSegment } from "./audio-analysis/repetition-detector.util";

interface CachedChunk {
  startMs: number;
  endMs: number;
  text: string;
  mfcc: number[];
  envelope: number[];
  pitchHz: number;
}

// Bump this whenever a change to the transcription/detection pipeline
// would produce meaningfully different output for the same source audio
// (model swap, language-detection fix, script/decoding change, chunking
// change, etc.). Root-caused a real bug: `transcriptCache` had no version
// marker at all, so `cached ?? reanalyze()` below reused transcripts
// forever, even after shipping fixes — a video scanned before the Hindi-
// transcription fix (commit 970e01d) kept serving the old broken
// transcript on every subsequent scan, with the fix having no effect for
// that asset until now. Bump this constant, don't just add a field, every
// time the pipeline changes again.
const ANALYSIS_VERSION = 2;

interface CachedAssetAnalysis {
  analysisVersion: number;
  language: string | null;
  chunks: CachedChunk[];
  speakerSegments: DiarizationSegment[];
}

interface ScanCheckpoint {
  completedAssetIds: string[];
}

@Injectable()
export class VoiceScanProcessor implements OnModuleDestroy {
  private readonly logger = new Logger("VoiceScanProcessor");
  private readonly worker: Worker<{ voiceScanJobId: string }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly whisper: WhisperService,
    private readonly diarization: DiarizationService,
    @Inject(VOICE_REDIS_CONNECTION) connection: Redis,
  ) {
    this.worker = new Worker(VOICE_SCAN_QUEUE_NAME, (job) => this.process(job), { connection, concurrency: 1 });
    this.worker.on("failed", (job, err) => this.logger.error(`Voice scan ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  private async process(job: Job<{ voiceScanJobId: string }>): Promise<void> {
    const scanJob = await this.prisma.voiceScanJob.findUnique({ where: { id: job.data.voiceScanJobId } });
    if (!scanJob) return;

    const workDir = await mkdtemp(join(tmpdir(), "procut-voicescan-"));
    try {
      if (await this.isCancelled(scanJob.id)) return this.markCancelled(scanJob.id);

      const version = await this.prisma.projectVersion.findFirst({ where: { projectId: scanJob.projectId }, orderBy: { createdAt: "desc" } });
      if (!version) throw new Error("This project has no saved timeline to scan");
      const timeline = compositionSchema.parse(version.composition);

      type MediaClip = Extract<Clip, { kind: "video" | "audio" }>;
      const allMediaClips = timeline.clips.filter((c): c is MediaClip => c.kind === "video" || c.kind === "audio");

      let clipsInScope: MediaClip[];
      if (scanJob.scope === VoiceScanScope.CLIP) {
        const clip = allMediaClips.find((c) => c.id === scanJob.clipId && c.trackId === scanJob.trackId);
        if (!clip) throw new Error("The selected clip no longer exists on the timeline");
        clipsInScope = [clip];
      } else {
        clipsInScope = allMediaClips;
      }

      const assetIds = Array.from(new Set(clipsInScope.map((c) => c.mediaAssetId)));
      const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: assetIds } } });
      const assetById = new Map(assets.map((a) => [a.id, a]));

      const audibleClips = clipsInScope.filter((c) => assetById.get(c.mediaAssetId)?.hasAudio);
      if (audibleClips.length === 0) throw new Error("There's no audio to scan — the selected clip(s) are silent or video-only");

      const checkpoint: ScanCheckpoint = (scanJob.checkpoint as unknown as ScanCheckpoint | null) ?? { completedAssetIds: [] };
      const audibleAssetIds = Array.from(new Set(audibleClips.map((c) => c.mediaAssetId)));

      await this.setStage(scanJob.id, VoiceScanStatus.EXTRACTING_AUDIO, "Extracting audio", 5);

      const analysisByAssetId = new Map<string, CachedAssetAnalysis>();
      for (const [index, assetId] of audibleAssetIds.entries()) {
        if (checkpoint.completedAssetIds.includes(assetId)) {
          const cached = this.validCache(assetById.get(assetId)?.transcriptCache);
          if (cached) {
            analysisByAssetId.set(assetId, cached);
            continue;
          }
        }

        if (await this.pausedOrCancelled(scanJob.id, checkpoint)) return;

        const asset = assetById.get(assetId)!;
        const cached = this.validCache(asset.transcriptCache);
        const analysis = cached ?? (await this.analyzeAsset(asset, workDir, scanJob.id));
        analysisByAssetId.set(assetId, analysis);

        if (!cached) {
          await this.prisma.mediaAsset.update({ where: { id: assetId }, data: { transcriptCache: analysis as unknown as Prisma.InputJsonValue } });
        }
        checkpoint.completedAssetIds.push(assetId);
        await this.prisma.voiceScanJob.update({ where: { id: scanJob.id }, data: { checkpoint: checkpoint as unknown as Prisma.InputJsonValue } });

        const progress = 10 + Math.round((60 * (index + 1)) / audibleAssetIds.length);
        await this.setStage(scanJob.id, VoiceScanStatus.TRANSCRIBING, `Transcribing dialogue (${index + 1}/${audibleAssetIds.length})`, progress);
        if (await this.pausedOrCancelled(scanJob.id, checkpoint)) return;
      }

      await this.setStage(scanJob.id, VoiceScanStatus.COMPARING, "Comparing repeated segments", 75);

      const segments: TranscriptSegment[] = [];
      for (const clip of audibleClips) {
        const analysis = analysisByAssetId.get(clip.mediaAssetId);
        if (!analysis) continue;
        const clipSourceStart = clip.trimInMs;
        const clipSourceEnd = clip.trimInMs + clip.durationMs;

        for (const chunk of analysis.chunks) {
          const overlapStart = Math.max(chunk.startMs, clipSourceStart);
          const overlapEnd = Math.min(chunk.endMs, clipSourceEnd);
          if (overlapEnd - overlapStart < 50) continue; // negligible sliver, not a real usable segment

          const timelineStart = clip.startMs + (overlapStart - clipSourceStart);
          const timelineEnd = clip.startMs + (overlapEnd - clipSourceStart);
          segments.push({
            id: `${clip.id}:${chunk.startMs}`,
            trackId: clip.trackId,
            clipId: clip.id,
            mediaAssetId: clip.mediaAssetId,
            startMs: timelineStart,
            endMs: timelineEnd,
            sourceStartMs: overlapStart,
            sourceEndMs: overlapEnd,
            text: chunk.text,
            speakerLabel: speakerForRange(analysis.speakerSegments, overlapStart, overlapEnd),
            audioFingerprint: chunk.mfcc,
            waveformEnvelope: chunk.envelope,
            pitchHz: chunk.pitchHz,
          });
        }
      }

      const thresholds = this.resolveThresholds(scanJob);
      const candidates = detectRepetitions(segments, thresholds);

      await this.setStage(scanJob.id, VoiceScanStatus.PREPARING_SUGGESTIONS, "Preparing correction suggestions", 92);
      if (await this.isCancelled(scanJob.id)) return this.markCancelled(scanJob.id);

      if (candidates.length > 0) {
        await this.prisma.repetitionResult.createMany({
          data: candidates.map((c) => ({
            voiceScanJobId: scanJob.id,
            trackId: c.repeated.trackId,
            clipId: c.repeated.clipId,
            mediaAssetId: c.repeated.mediaAssetId,
            kind: c.kind as RepetitionKind,
            originalStartMs: c.original.startMs,
            originalEndMs: c.original.endMs,
            repeatedStartMs: c.repeated.startMs,
            repeatedEndMs: c.repeated.endMs,
            // Source-relative copies — the only coordinates that stay valid
            // once the user edits the timeline. See the schema comment.
            sourceOriginalStartMs: c.original.sourceStartMs,
            sourceOriginalEndMs: c.original.sourceEndMs,
            sourceRepeatedStartMs: c.repeated.sourceStartMs,
            sourceRepeatedEndMs: c.repeated.sourceEndMs,
            originalText: c.original.text,
            repeatedText: c.repeated.text,
            speakerLabel: c.repeated.speakerLabel ?? null,
            transcriptSimilarity: c.transcriptSimilarity,
            audioSimilarity: c.audioSimilarity,
            timingGapMs: c.timingGapMs,
            confidenceScore: c.confidenceScore,
            confidenceBucket: c.confidenceBucket as ConfidenceBucket,
            suggestedMode: c.suggestedMode as CorrectionMode,
          })),
        });
      }

      await this.prisma.voiceScanJob.update({
        where: { id: scanJob.id },
        data: { status: VoiceScanStatus.COMPLETED, progress: 100, stageLabel: null, completedAt: new Date() },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice scan failed";
      await this.prisma.voiceScanJob.update({ where: { id: scanJob.id }, data: { status: VoiceScanStatus.FAILED, errorMessage: message } });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Downloads one source once, runs VAD + Whisper + per-chunk audio
  // fingerprinting + diarization on it, and returns the cacheable result —
  // never touches (or re-uploads) the original file.
  private async analyzeAsset(asset: MediaAsset, workDir: string, scanJobId: string): Promise<CachedAssetAnalysis> {
    const localPath = join(workDir, `${asset.id}${extname(asset.storageKey) || ".bin"}`);
    await this.storage.downloadToFile(asset.storageKey, localPath);

    await this.setStage(scanJobId, VoiceScanStatus.DETECTING_SPEECH, "Detecting speech", undefined);
    const totalDurationMs = asset.durationMs ?? 0;
    const speechRegions = totalDurationMs > 0 ? await this.safeDetectSpeech(localPath, totalDurationMs) : [];
    if (speechRegions.length === 0) return { analysisVersion: ANALYSIS_VERSION, language: null, chunks: [], speakerSegments: [] };

    const { samples } = await extractPcm(localPath, WHISPER_SAMPLE_RATE);
    const transcription = await this.whisper.transcribe(samples);

    const chunks: CachedChunk[] = transcription.segments
      .filter((seg) => speechRegions.some((r) => Math.min(seg.endMs, r.endMs) - Math.max(seg.startMs, r.startMs) > 0))
      .map((seg) => {
        const startSample = Math.max(0, Math.floor((seg.startMs / 1000) * WHISPER_SAMPLE_RATE));
        const endSample = Math.min(samples.length, Math.ceil((seg.endMs / 1000) * WHISPER_SAMPLE_RATE));
        const slice = samples.subarray(startSample, Math.max(startSample, endSample));
        return {
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          mfcc: computeMfccFingerprint(slice, WHISPER_SAMPLE_RATE),
          envelope: computeEnergyEnvelope(slice),
          pitchHz: estimatePitchHz(slice, WHISPER_SAMPLE_RATE),
        };
      });

    await this.setStage(scanJobId, VoiceScanStatus.DIARIZING, "Identifying speakers", undefined);
    const speakerSegments = await this.diarization.diarize(localPath);

    return { analysisVersion: ANALYSIS_VERSION, language: transcription.language, chunks, speakerSegments };
  }

  // Treats a cache entry as usable only if it was written by the current
  // pipeline version — see ANALYSIS_VERSION's comment. Anything missing
  // the field at all (data from before this fix existed) or stamped with
  // an older number is discarded, forcing a real re-analysis.
  private validCache(raw: unknown): CachedAssetAnalysis | null {
    const cached = raw as unknown as CachedAssetAnalysis | null;
    if (!cached || cached.analysisVersion !== ANALYSIS_VERSION) return null;
    return cached;
  }

  private async safeDetectSpeech(localPath: string, totalDurationMs: number) {
    try {
      return await detectSpeechRegions(localPath, totalDurationMs);
    } catch (err) {
      this.logger.warn(`Voice activity detection failed, falling back to treating the whole clip as speech: ${err instanceof Error ? err.message : err}`);
      return [{ startMs: 0, endMs: totalDurationMs }];
    }
  }

  private resolveThresholds(scanJob: { sensitivityPreset: string; customThresholds: unknown }): SensitivityThresholds {
    if (scanJob.sensitivityPreset === "CUSTOM" && scanJob.customThresholds) {
      const c = scanJob.customThresholds as {
        transcriptSimilarityPct: number;
        audioSimilarityPct: number;
        maxGapMs: number;
        minSegmentDurationMs: number;
        confidenceThreshold: number;
      };
      return { ...c, confidenceThreshold: c.confidenceThreshold / 100 };
    }
    return SENSITIVITY_PRESETS[scanJob.sensitivityPreset as keyof typeof SENSITIVITY_PRESETS] ?? SENSITIVITY_PRESETS.BALANCED;
  }

  private async isCancelled(scanJobId: string): Promise<boolean> {
    const job = await this.prisma.voiceScanJob.findUnique({ where: { id: scanJobId }, select: { cancelRequested: true } });
    return job?.cancelRequested ?? false;
  }

  private async pausedOrCancelled(scanJobId: string, checkpoint: ScanCheckpoint): Promise<boolean> {
    const job = await this.prisma.voiceScanJob.findUnique({ where: { id: scanJobId }, select: { cancelRequested: true, pauseRequested: true } });
    if (job?.cancelRequested) {
      await this.markCancelled(scanJobId);
      return true;
    }
    if (job?.pauseRequested) {
      await this.prisma.voiceScanJob.update({
        where: { id: scanJobId },
        data: {
          status: VoiceScanStatus.PAUSED,
          pauseRequested: false,
          stageLabel: "Paused",
          checkpoint: checkpoint as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    }
    return false;
  }

  private async markCancelled(scanJobId: string): Promise<void> {
    await this.prisma.voiceScanJob.update({ where: { id: scanJobId }, data: { status: VoiceScanStatus.CANCELLED } });
  }

  private setStage(scanJobId: string, status: VoiceScanStatus, stageLabel: string, progress: number | undefined) {
    return this.prisma.voiceScanJob.update({ where: { id: scanJobId }, data: { status, stageLabel, ...(progress != null ? { progress } : {}) } });
  }
}

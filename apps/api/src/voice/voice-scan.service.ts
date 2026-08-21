import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ConfidenceBucket, CorrectionMode, Prisma, RepetitionReviewStatus, SensitivityPreset, VoiceScanJob, VoiceScanScope, VoiceScanStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "../projects/projects.service";
import { compositionSchema, type Clip } from "../projects/composition.schema";
import { CreateVoiceScanDto } from "./dto/create-voice-scan.dto";
import { BatchMarkResultsDto, MarkResultDto } from "./dto/mark-result.dto";
import { VOICE_SCAN_QUEUE } from "./voice.constants";
import { buildTimelineSegments } from "./audio-analysis/timeline-segments.util";

const ACTIVE_STATUSES: VoiceScanStatus[] = [
  VoiceScanStatus.QUEUED,
  VoiceScanStatus.EXTRACTING_AUDIO,
  VoiceScanStatus.DETECTING_SPEECH,
  VoiceScanStatus.TRANSCRIBING,
  VoiceScanStatus.DIARIZING,
  VoiceScanStatus.COMPARING,
  VoiceScanStatus.PREPARING_SUGGESTIONS,
];

export interface BatchPreview {
  totalPending: number;
  highConfidencePending: number;
  needsReviewPending: number;
  estimatedDurationRemovedMs: number;
}

export interface TranscriptLine {
  id: string;
  trackId: string;
  clipId: string;
  startMs: number;
  endMs: number;
  text: string;
  role: "original" | "repeated" | null;
  repetitionResultId: string | null;
  confidenceBucket: ConfidenceBucket | null;
  status: RepetitionReviewStatus | null;
  suggestedMode: CorrectionMode | null;
}

interface CachedTranscript {
  chunks: { startMs: number; endMs: number; text: string }[];
}

@Injectable()
export class VoiceScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    @Inject(VOICE_SCAN_QUEUE) private readonly queue: Queue<{ voiceScanJobId: string }>,
  ) {}

  async createScan(userId: string, projectId: string, dto: CreateVoiceScanDto): Promise<VoiceScanJob> {
    await this.projects.ensureEditable(userId, projectId);

    if (dto.scope === VoiceScanScope.CLIP && (!dto.trackId || !dto.clipId)) {
      throw new BadRequestException("trackId and clipId are required when scanning a single clip");
    }
    if (dto.sensitivityPreset === SensitivityPreset.CUSTOM && !dto.customThresholds) {
      throw new BadRequestException("customThresholds are required when sensitivityPreset is CUSTOM");
    }

    const active = await this.prisma.voiceScanJob.findFirst({ where: { projectId, status: { in: ACTIVE_STATUSES } } });
    if (active) throw new BadRequestException("A voice scan is already in progress for this project");

    const job = await this.prisma.voiceScanJob.create({
      data: {
        projectId,
        scope: dto.scope,
        trackId: dto.scope === VoiceScanScope.CLIP ? dto.trackId : null,
        clipId: dto.scope === VoiceScanScope.CLIP ? dto.clipId : null,
        sensitivityPreset: dto.sensitivityPreset ?? SensitivityPreset.BALANCED,
        customThresholds: dto.customThresholds ? (dto.customThresholds as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        requestedById: userId,
      },
    });

    await this.queue.add("voice-scan", { voiceScanJobId: job.id }, { jobId: job.id, removeOnComplete: true, removeOnFail: true });
    return job;
  }

  async list(userId: string, projectId: string): Promise<VoiceScanJob[]> {
    await this.projects.findOne(userId, projectId);
    return this.prisma.voiceScanJob.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  }

  async get(userId: string, projectId: string, jobId: string): Promise<VoiceScanJob> {
    await this.projects.findOne(userId, projectId);
    return this.findJobOrThrow(projectId, jobId);
  }

  async results(userId: string, projectId: string, jobId: string) {
    await this.projects.findOne(userId, projectId);
    await this.findJobOrThrow(projectId, jobId);
    return this.prisma.repetitionResult.findMany({ where: { voiceScanJobId: jobId }, orderBy: { originalStartMs: "asc" } });
  }

  // Full chronological transcript for a completed scan, in the same
  // Devanagari/Latin script Whisper produced it, with each line cross-
  // referenced against this job's RepetitionResult rows so the frontend
  // can highlight exactly which sentence is the kept "original" take vs.
  // the "repeated" one flagged for correction — the sentence-level review
  // view, as opposed to /results' pairwise original/repeated snippets.
  //
  // Re-derived from each asset's cached transcript against the *current*
  // saved composition, not a snapshot from scan time — if a clip has
  // since moved on the timeline, a line's re-computed position may no
  // longer match its RepetitionResult's stored position, in which case it
  // simply renders unflagged rather than erroring (the same soft-fail
  // already used when applying a correction to a clip that's moved).
  async transcript(userId: string, projectId: string, jobId: string): Promise<TranscriptLine[]> {
    await this.projects.findOne(userId, projectId);
    const job = await this.findJobOrThrow(projectId, jobId);

    const version = await this.prisma.projectVersion.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
    if (!version) return [];
    const timeline = compositionSchema.parse(version.composition);

    type MediaClip = Extract<Clip, { kind: "video" | "audio" }>;
    const allMediaClips = timeline.clips.filter((c): c is MediaClip => c.kind === "video" || c.kind === "audio");
    const clipsInScope =
      job.scope === VoiceScanScope.CLIP ? allMediaClips.filter((c) => c.id === job.clipId && c.trackId === job.trackId) : allMediaClips;
    if (clipsInScope.length === 0) return [];

    const assetIds = Array.from(new Set(clipsInScope.map((c) => c.mediaAssetId)));
    const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: assetIds } } });
    const assetById = new Map(assets.map((a) => [a.id, a]));

    const results = await this.prisma.repetitionResult.findMany({ where: { voiceScanJobId: jobId } });
    const resultByKey = new Map<string, { result: (typeof results)[number]; role: "original" | "repeated" }>();
    for (const r of results) {
      resultByKey.set(`${r.clipId}:${r.originalStartMs}`, { result: r, role: "original" });
      resultByKey.set(`${r.clipId}:${r.repeatedStartMs}`, { result: r, role: "repeated" });
    }

    const lines: TranscriptLine[] = [];
    for (const clip of clipsInScope) {
      const cache = assetById.get(clip.mediaAssetId)?.transcriptCache as unknown as CachedTranscript | null;
      if (!cache?.chunks?.length) continue;

      const segments = buildTimelineSegments(clip, cache.chunks);
      for (const seg of segments) {
        const match = resultByKey.get(`${seg.clipId}:${seg.startMs}`);
        lines.push({
          id: seg.id,
          trackId: seg.trackId,
          clipId: seg.clipId,
          startMs: seg.startMs,
          endMs: seg.endMs,
          text: seg.text,
          role: match?.role ?? null,
          repetitionResultId: match?.result.id ?? null,
          confidenceBucket: match?.result.confidenceBucket ?? null,
          status: match?.result.status ?? null,
          suggestedMode: match?.result.suggestedMode ?? null,
        });
      }
    }

    return lines.sort((a, b) => a.startMs - b.startMs);
  }

  async cancel(userId: string, projectId: string, jobId: string): Promise<VoiceScanJob> {
    await this.projects.ensureEditable(userId, projectId);
    const job = await this.findJobOrThrow(projectId, jobId);
    if (!ACTIVE_STATUSES.includes(job.status)) return job;
    return this.prisma.voiceScanJob.update({ where: { id: jobId }, data: { cancelRequested: true } });
  }

  async pause(userId: string, projectId: string, jobId: string): Promise<VoiceScanJob> {
    await this.projects.ensureEditable(userId, projectId);
    const job = await this.findJobOrThrow(projectId, jobId);
    if (!ACTIVE_STATUSES.includes(job.status)) throw new BadRequestException("This scan isn't running, so it can't be paused");
    return this.prisma.voiceScanJob.update({ where: { id: jobId }, data: { pauseRequested: true } });
  }

  async resume(userId: string, projectId: string, jobId: string): Promise<VoiceScanJob> {
    await this.projects.ensureEditable(userId, projectId);
    const job = await this.findJobOrThrow(projectId, jobId);
    if (job.status !== VoiceScanStatus.PAUSED) throw new BadRequestException("This scan isn't paused, so it can't be resumed");

    const resumed = await this.prisma.voiceScanJob.update({
      where: { id: jobId },
      data: { status: VoiceScanStatus.QUEUED, pauseRequested: false, cancelRequested: false, stageLabel: "Resuming from where it left off" },
    });
    await this.queue.add("voice-scan", { voiceScanJobId: jobId }, { jobId: `${jobId}-resume-${Date.now()}`, removeOnComplete: true, removeOnFail: true });
    return resumed;
  }

  async markResult(userId: string, projectId: string, jobId: string, resultId: string, dto: MarkResultDto) {
    await this.projects.ensureEditable(userId, projectId);
    await this.findJobOrThrow(projectId, jobId);
    const result = await this.prisma.repetitionResult.findUnique({ where: { id: resultId } });
    if (!result || result.voiceScanJobId !== jobId) throw new NotFoundException("Repetition result not found");

    if (dto.status === RepetitionReviewStatus.APPLIED && !dto.appliedMode) {
      throw new BadRequestException("appliedMode is required when marking a result as applied");
    }

    return this.prisma.repetitionResult.update({
      where: { id: resultId },
      data: { status: dto.status, appliedMode: dto.status === RepetitionReviewStatus.APPLIED ? dto.appliedMode : null },
    });
  }

  async batchPreview(userId: string, projectId: string, jobId: string): Promise<BatchPreview> {
    await this.projects.findOne(userId, projectId);
    await this.findJobOrThrow(projectId, jobId);
    const pending = await this.prisma.repetitionResult.findMany({ where: { voiceScanJobId: jobId, status: RepetitionReviewStatus.PENDING } });

    const highConfidence = pending.filter((r) => r.confidenceBucket === ConfidenceBucket.HIGH);
    return {
      totalPending: pending.length,
      highConfidencePending: highConfidence.length,
      needsReviewPending: pending.length - highConfidence.length,
      estimatedDurationRemovedMs: highConfidence.reduce((sum, r) => sum + (r.repeatedEndMs - r.repeatedStartMs), 0),
    };
  }

  // Bookkeeping only — same as markResult, the actual timeline edit
  // already happened client-side via the normal composition save before
  // this is called (see the frontend's applyBatchCorrections, which loops
  // the same addAudioPatch/removeRangeOnTrack helpers a single manual
  // correction uses, then saves once and calls this to record the
  // decision for every result in the batch). Each result gets its own
  // appliedMode rather than one shared mode, since a real batch is rarely
  // uniform (some results resolve as audio-only patches, others as
  // audio+video trims, depending on each one's own suggestedMode).
  async batchMark(userId: string, projectId: string, jobId: string, dto: BatchMarkResultsDto) {
    await this.projects.ensureEditable(userId, projectId);
    await this.findJobOrThrow(projectId, jobId);
    const ids = dto.results.map((r) => r.id);
    const owned = await this.prisma.repetitionResult.findMany({ where: { id: { in: ids }, voiceScanJobId: jobId }, select: { id: true } });
    const ownedIds = new Set(owned.map((r) => r.id));

    const updated = await Promise.all(
      dto.results
        .filter((r) => ownedIds.has(r.id))
        .map((r) =>
          this.prisma.repetitionResult.update({
            where: { id: r.id },
            data: { status: RepetitionReviewStatus.APPLIED, appliedMode: r.appliedMode },
          }),
        ),
    );
    return { updated: updated.length };
  }

  private async findJobOrThrow(projectId: string, jobId: string): Promise<VoiceScanJob> {
    const job = await this.prisma.voiceScanJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException("Voice scan job not found");
    return job;
  }
}

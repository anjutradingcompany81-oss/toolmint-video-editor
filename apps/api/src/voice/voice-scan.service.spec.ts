import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { VoiceScanService } from "./voice-scan.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "../projects/projects.service";

function buildJob(overrides: Partial<{ id: string; projectId: string; status: string; cancelRequested: boolean; pauseRequested: boolean }> = {}) {
  return {
    id: overrides.id ?? "job_1",
    projectId: overrides.projectId ?? "proj_1",
    scope: "TIMELINE",
    trackId: null,
    clipId: null,
    status: overrides.status ?? "QUEUED",
    stageLabel: null,
    progress: 0,
    sensitivityPreset: "BALANCED",
    customThresholds: null,
    cancelRequested: overrides.cancelRequested ?? false,
    pauseRequested: overrides.pauseRequested ?? false,
    checkpoint: null,
    errorMessage: null,
    requestedById: "user_1",
    createdAt: new Date(),
    completedAt: null,
  };
}

function buildResult(overrides: Partial<{ id: string; voiceScanJobId: string; confidenceBucket: string; status: string }> = {}) {
  return {
    id: overrides.id ?? "result_1",
    voiceScanJobId: overrides.voiceScanJobId ?? "job_1",
    trackId: "track_1",
    clipId: "clip_1",
    mediaAssetId: "asset_1",
    kind: "SENTENCE",
    originalStartMs: 0,
    originalEndMs: 2000,
    repeatedStartMs: 2200,
    repeatedEndMs: 4200,
    originalText: "hello there",
    repeatedText: "hello there",
    speakerLabel: null,
    transcriptSimilarity: 1,
    audioSimilarity: 0.9,
    timingGapMs: 200,
    confidenceScore: 0.9,
    confidenceBucket: overrides.confidenceBucket ?? "HIGH",
    suggestedMode: "AUDIO_ONLY",
    status: overrides.status ?? "PENDING",
    appliedMode: null,
    createdAt: new Date(),
  };
}

describe("VoiceScanService", () => {
  let prisma: {
    voiceScanJob: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    repetitionResult: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let projects: jest.Mocked<Pick<ProjectsService, "ensureEditable" | "findOne">>;
  let queue: jest.Mocked<Pick<Queue, "add">>;
  let service: VoiceScanService;

  beforeEach(() => {
    prisma = {
      voiceScanJob: {
        create: jest.fn().mockResolvedValue(buildJob()),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(buildJob()),
        update: jest.fn().mockImplementation((args) => Promise.resolve({ ...buildJob(), ...args.data })),
      },
      repetitionResult: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    projects = {
      ensureEditable: jest.fn().mockResolvedValue({ id: "proj_1" }),
      findOne: jest.fn().mockResolvedValue({ id: "proj_1" }),
    };
    queue = { add: jest.fn().mockResolvedValue({}) };

    service = new VoiceScanService(prisma as unknown as PrismaService, projects as unknown as ProjectsService, queue as unknown as Queue);
  });

  describe("createScan", () => {
    it("requires edit permission, creates a job row, and enqueues it with a matching jobId", async () => {
      const result = await service.createScan("user_1", "proj_1", { scope: "TIMELINE" as never });

      expect(projects.ensureEditable).toHaveBeenCalledWith("user_1", "proj_1");
      expect(prisma.voiceScanJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ projectId: "proj_1", scope: "TIMELINE" }) }));
      expect(queue.add).toHaveBeenCalledWith("voice-scan", { voiceScanJobId: "job_1" }, expect.objectContaining({ jobId: "job_1" }));
      expect(result.id).toBe("job_1");
    });

    it("rejects a CLIP-scope scan missing trackId/clipId", async () => {
      await expect(service.createScan("user_1", "proj_1", { scope: "CLIP" as never })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.voiceScanJob.create).not.toHaveBeenCalled();
    });

    it("rejects a CUSTOM sensitivity scan missing customThresholds", async () => {
      await expect(service.createScan("user_1", "proj_1", { scope: "TIMELINE" as never, sensitivityPreset: "CUSTOM" as never })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("rejects a new scan while one is already in progress for the project", async () => {
      prisma.voiceScanJob.findFirst.mockResolvedValueOnce(buildJob({ status: "TRANSCRIBING" }));

      await expect(service.createScan("user_1", "proj_1", { scope: "TIMELINE" as never })).rejects.toBeInstanceOf(BadRequestException);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe("cancel / pause / resume", () => {
    it("flags a running scan for cancellation", async () => {
      prisma.voiceScanJob.findUnique.mockResolvedValue(buildJob({ status: "TRANSCRIBING" }));
      await service.cancel("user_1", "proj_1", "job_1");
      expect(prisma.voiceScanJob.update).toHaveBeenCalledWith({ where: { id: "job_1" }, data: { cancelRequested: true } });
    });

    it("refuses to pause a scan that isn't running", async () => {
      prisma.voiceScanJob.findUnique.mockResolvedValue(buildJob({ status: "COMPLETED" }));
      await expect(service.pause("user_1", "proj_1", "job_1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to resume a scan that isn't paused", async () => {
      prisma.voiceScanJob.findUnique.mockResolvedValue(buildJob({ status: "TRANSCRIBING" }));
      await expect(service.resume("user_1", "proj_1", "job_1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("re-enqueues a paused scan on resume", async () => {
      prisma.voiceScanJob.findUnique.mockResolvedValue(buildJob({ status: "PAUSED" }));
      await service.resume("user_1", "proj_1", "job_1");
      expect(queue.add).toHaveBeenCalledWith("voice-scan", { voiceScanJobId: "job_1" }, expect.objectContaining({ jobId: expect.stringContaining("job_1-resume-") }));
    });

    it("404s cancel for a job belonging to a different project", async () => {
      prisma.voiceScanJob.findUnique.mockResolvedValue(buildJob({ projectId: "other-project" }));
      await expect(service.cancel("user_1", "proj_1", "job_1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("markResult", () => {
    it("requires appliedMode when marking a result APPLIED", async () => {
      prisma.repetitionResult.findUnique.mockResolvedValue(buildResult());
      await expect(service.markResult("user_1", "proj_1", "job_1", "result_1", { status: "APPLIED" as never })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("updates status and appliedMode together", async () => {
      prisma.repetitionResult.findUnique.mockResolvedValue(buildResult());
      await service.markResult("user_1", "proj_1", "job_1", "result_1", { status: "APPLIED" as never, appliedMode: "AUDIO_ONLY" as never });
      expect(prisma.repetitionResult.update).toHaveBeenCalledWith({
        where: { id: "result_1" },
        data: { status: "APPLIED", appliedMode: "AUDIO_ONLY" },
      });
    });

    it("clears appliedMode when marking a result DISMISSED", async () => {
      prisma.repetitionResult.findUnique.mockResolvedValue(buildResult());
      await service.markResult("user_1", "proj_1", "job_1", "result_1", { status: "DISMISSED" as never });
      expect(prisma.repetitionResult.update).toHaveBeenCalledWith({ where: { id: "result_1" }, data: { status: "DISMISSED", appliedMode: null } });
    });

    it("404s for a result belonging to a different scan job", async () => {
      prisma.repetitionResult.findUnique.mockResolvedValue(buildResult({ voiceScanJobId: "other-job" }));
      await expect(service.markResult("user_1", "proj_1", "job_1", "result_1", { status: "DISMISSED" as never })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("batchPreview", () => {
    it("summarizes pending results by confidence and estimates removed duration from high-confidence ones only", async () => {
      prisma.repetitionResult.findMany.mockResolvedValue([
        buildResult({ id: "a", confidenceBucket: "HIGH" }), // 2000ms repeated span
        buildResult({ id: "b", confidenceBucket: "MEDIUM" }),
        buildResult({ id: "c", confidenceBucket: "LOW" }),
      ]);

      const preview = await service.batchPreview("user_1", "proj_1", "job_1");
      expect(preview.totalPending).toBe(3);
      expect(preview.highConfidencePending).toBe(1);
      expect(preview.needsReviewPending).toBe(2);
      expect(preview.estimatedDurationRemovedMs).toBe(2000);
    });
  });

  describe("batchMark", () => {
    it("applies each result's own appliedMode rather than one shared mode for the whole batch", async () => {
      prisma.repetitionResult.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
      prisma.repetitionResult.update.mockResolvedValue(buildResult());

      const result = await service.batchMark("user_1", "proj_1", "job_1", {
        results: [
          { id: "a", appliedMode: "AUDIO_ONLY" as never },
          { id: "b", appliedMode: "AUDIO_VIDEO_TRIM" as never },
        ],
      });

      expect(prisma.repetitionResult.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { status: "APPLIED", appliedMode: "AUDIO_ONLY" } });
      expect(prisma.repetitionResult.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { status: "APPLIED", appliedMode: "AUDIO_VIDEO_TRIM" } });
      expect(result.updated).toBe(2);
    });

    it("silently skips a result id that doesn't belong to this scan job rather than updating it", async () => {
      prisma.repetitionResult.findMany.mockResolvedValue([{ id: "a" }]); // "b" not owned by this job
      prisma.repetitionResult.update.mockResolvedValue(buildResult());

      const result = await service.batchMark("user_1", "proj_1", "job_1", {
        results: [
          { id: "a", appliedMode: "AUDIO_ONLY" as never },
          { id: "b", appliedMode: "AUDIO_ONLY" as never },
        ],
      });

      expect(prisma.repetitionResult.update).toHaveBeenCalledTimes(1);
      expect(result.updated).toBe(1);
    });
  });
});

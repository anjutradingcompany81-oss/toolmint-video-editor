import { NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { RenderService } from "./render.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "../projects/projects.service";
import type { StorageService } from "../storage/storage.service";

function buildJob(overrides: Partial<{ id: string; projectId: string; status: string; outputStorageKey: string | null }> = {}) {
  return {
    id: overrides.id ?? "job_1",
    projectId: overrides.projectId ?? "proj_1",
    sceneId: "scn_1",
    resolution: "R720P",
    status: overrides.status ?? "QUEUED",
    progress: 0,
    errorMessage: null,
    outputStorageKey: overrides.outputStorageKey ?? null,
    outputByteSize: null,
    requestedById: "user_1",
    createdAt: new Date(),
    completedAt: null,
  };
}

describe("RenderService", () => {
  let prisma: { exportJob: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock } };
  let projects: jest.Mocked<Pick<ProjectsService, "ensureEditable" | "findOne">>;
  let storage: jest.Mocked<Pick<StorageService, "presignDownload">>;
  let queue: jest.Mocked<Pick<Queue, "add">>;
  let service: RenderService;

  beforeEach(() => {
    prisma = {
      exportJob: {
        create: jest.fn().mockResolvedValue(buildJob()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
    };
    projects = {
      ensureEditable: jest.fn().mockResolvedValue({ id: "proj_1" }),
      findOne: jest.fn().mockResolvedValue({ id: "proj_1" }),
    };
    storage = { presignDownload: jest.fn().mockResolvedValue("https://storage.example/signed") };
    queue = { add: jest.fn().mockResolvedValue({}) };

    service = new RenderService(
      prisma as unknown as PrismaService,
      projects as unknown as ProjectsService,
      storage as unknown as StorageService,
      queue as unknown as Queue,
    );
  });

  describe("createExport", () => {
    it("requires edit permission, creates a job row, and enqueues it with a matching jobId", async () => {
      const result = await service.createExport("user_1", "proj_1", "scn_1", "R720P");

      expect(projects.ensureEditable).toHaveBeenCalledWith("user_1", "proj_1");
      expect(prisma.exportJob.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ projectId: "proj_1", sceneId: "scn_1", resolution: "R720P" }) }),
      );
      expect(queue.add).toHaveBeenCalledWith("render-scene", { exportJobId: "job_1" }, expect.objectContaining({ jobId: "job_1" }));
      expect(result.id).toBe("job_1");
      expect(result.downloadUrl).toBeNull();
    });
  });

  describe("get", () => {
    it("attaches a signed download URL only for a completed job", async () => {
      prisma.exportJob.findUnique.mockResolvedValue(buildJob({ status: "COMPLETED", outputStorageKey: "exports/proj_1/job_1.mp4" }));

      const result = await service.get("user_1", "proj_1", "job_1");

      expect(storage.presignDownload).toHaveBeenCalledWith("exports/proj_1/job_1.mp4");
      expect(result.downloadUrl).toBe("https://storage.example/signed");
    });

    it("does not sign a download URL for a job still in progress", async () => {
      prisma.exportJob.findUnique.mockResolvedValue(buildJob({ status: "PROCESSING" }));

      const result = await service.get("user_1", "proj_1", "job_1");

      expect(storage.presignDownload).not.toHaveBeenCalled();
      expect(result.downloadUrl).toBeNull();
    });

    it("404s for a job belonging to a different project", async () => {
      prisma.exportJob.findUnique.mockResolvedValue(buildJob({ projectId: "other-project" }));

      await expect(service.get("user_1", "proj_1", "job_1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s for a missing job", async () => {
      prisma.exportJob.findUnique.mockResolvedValue(null);

      await expect(service.get("user_1", "proj_1", "job_1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("list", () => {
    it("checks read access before listing", async () => {
      await service.list("user_1", "proj_1");
      expect(projects.findOne).toHaveBeenCalledWith("user_1", "proj_1");
    });
  });
});

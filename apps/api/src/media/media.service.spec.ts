import { BadRequestException, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { MediaAssetKind, MediaAssetStatus, Prisma } from "@prisma/client";
import { MediaService } from "./media.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import type { ProjectsService } from "../projects/projects.service";
import type { MediaProbeService } from "./media-probe.service";

interface PrismaMock {
  mediaAsset: { create: jest.Mock; update: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; delete: jest.Mock };
}

function buildFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: "file",
    originalname: "clip.mp4",
    encoding: "7bit",
    mimetype: "video/mp4",
    size: 1024,
    buffer: Buffer.from("fake video bytes"),
    destination: "",
    filename: "",
    path: "",
    stream: undefined as never,
    ...overrides,
  };
}

function buildAsset(overrides: Partial<{ id: string; projectId: string; status: MediaAssetStatus; storageKey: string }> = {}) {
  return {
    id: overrides.id ?? "asset_1",
    projectId: overrides.projectId ?? "proj_1",
    kind: MediaAssetKind.VIDEO,
    status: overrides.status ?? MediaAssetStatus.READY,
    originalName: "clip.mp4",
    storageKey: overrides.storageKey ?? "projects/proj_1/asset_1/clip.mp4",
    proxyKey: null,
    mimeType: "video/mp4",
    byteSize: 1024,
    durationMs: null,
    width: null,
    height: null,
    checksum: "abc",
    uploadedById: "user_1",
    createdAt: new Date(),
  };
}

describe("MediaService", () => {
  let prisma: PrismaMock;
  let storage: jest.Mocked<Pick<StorageService, "putObject" | "delete" | "presignDownload">>;
  let projects: jest.Mocked<Pick<ProjectsService, "ensureEditable" | "findOne">>;
  let probe: jest.Mocked<Pick<MediaProbeService, "probe">>;
  let service: MediaService;

  beforeEach(() => {
    prisma = {
      mediaAsset: {
        create: jest.fn().mockResolvedValue(buildAsset({ status: MediaAssetStatus.UPLOADING })),
        update: jest.fn().mockResolvedValue(buildAsset()),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      presignDownload: jest.fn().mockResolvedValue("https://storage.example/signed"),
    };
    projects = {
      ensureEditable: jest.fn().mockResolvedValue({ id: "proj_1" }),
      findOne: jest.fn().mockResolvedValue({ id: "proj_1" }),
    };
    probe = {
      probe: jest.fn().mockResolvedValue({ durationMs: null, width: null, height: null, waveformPeaks: null }),
    };

    service = new MediaService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      projects as unknown as ProjectsService,
      probe as unknown as MediaProbeService,
    );
  });

  describe("upload", () => {
    it("rejects an unsupported mime type before touching storage", async () => {
      const file = buildFile({ mimetype: "application/x-msdownload" });

      await expect(service.upload("user_1", "proj_1", file)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it("rejects a file over the per-kind size limit", async () => {
      const file = buildFile({ mimetype: "image/png", size: 999_999_999 });

      await expect(service.upload("user_1", "proj_1", file)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it("stores the object and marks the asset READY on success", async () => {
      const file = buildFile();

      const result = await service.upload("user_1", "proj_1", file);

      expect(projects.ensureEditable).toHaveBeenCalledWith("user_1", "proj_1");
      expect(storage.putObject).toHaveBeenCalledWith(expect.stringContaining("projects/proj_1/"), file.buffer, "video/mp4");
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: MediaAssetStatus.READY, durationMs: null, width: null, height: null, waveformPeaks: Prisma.JsonNull },
        }),
      );
      expect(result.previewUrl).toBe("https://storage.example/signed");
    });

    it("probes video uploads for duration/dimensions/waveform and persists the result", async () => {
      probe.probe.mockResolvedValueOnce({ durationMs: 6000, width: 640, height: 360, waveformPeaks: [-0.5, 0.5] });
      const file = buildFile();

      await service.upload("user_1", "proj_1", file);

      expect(probe.probe).toHaveBeenCalledWith(file.buffer, "mp4", true);
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: MediaAssetStatus.READY, durationMs: 6000, width: 640, height: 360, waveformPeaks: [-0.5, 0.5] },
        }),
      );
    });

    it("skips probing entirely for documents", async () => {
      const file = buildFile({ originalname: "brief.pdf", mimetype: "application/pdf" });

      await service.upload("user_1", "proj_1", file);

      expect(probe.probe).not.toHaveBeenCalled();
    });

    it("still marks the asset READY when probing throws", async () => {
      probe.probe.mockRejectedValueOnce(new Error("ffprobe crashed"));
      const file = buildFile();

      const result = await service.upload("user_1", "proj_1", file);

      expect(result.status).toBe(MediaAssetStatus.READY);
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: MediaAssetStatus.READY, durationMs: null, width: null, height: null, waveformPeaks: Prisma.JsonNull },
        }),
      );
    });

    it("marks the asset FAILED and surfaces a 500 when the storage write fails", async () => {
      storage.putObject.mockRejectedValueOnce(new Error("bucket unreachable"));
      const file = buildFile();

      await expect(service.upload("user_1", "proj_1", file)).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(prisma.mediaAsset.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: MediaAssetStatus.FAILED } }),
      );
    });
  });

  describe("list", () => {
    it("only attaches a preview URL to READY assets", async () => {
      prisma.mediaAsset.findMany.mockResolvedValue([
        buildAsset({ id: "a", status: MediaAssetStatus.READY }),
        buildAsset({ id: "b", status: MediaAssetStatus.UPLOADING }),
      ]);

      const result = await service.list("user_1", "proj_1");

      expect(result.find((a) => a.id === "a")?.previewUrl).toBe("https://storage.example/signed");
      expect(result.find((a) => a.id === "b")?.previewUrl).toBeNull();
    });
  });

  describe("remove", () => {
    it("deletes the storage object and the DB row", async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(buildAsset());

      await service.remove("user_1", "proj_1", "asset_1");

      expect(storage.delete).toHaveBeenCalledWith("projects/proj_1/asset_1/clip.mp4");
      expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: "asset_1" } });
    });

    it("404s when the asset belongs to a different project", async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(buildAsset({ projectId: "other-project" }));

      await expect(service.remove("user_1", "proj_1", "asset_1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CompositionService } from "./composition.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "./projects.service";
import type { Composition } from "./composition.schema";

const TRACK_ID = "track_1";

function buildComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    schemaVersion: "2.0",
    tracks: [{ id: TRACK_ID, kind: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, solo: false }],
    clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000, trimInMs: 0, trimOutMs: 0, volume: 1, muted: false, speedPercent: 100, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, audioPatches: [] }],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("CompositionService", () => {
  let prisma: { projectVersion: { findFirst: jest.Mock; create: jest.Mock } };
  let projects: jest.Mocked<Pick<ProjectsService, "findOne" | "ensureEditable">>;
  let service: CompositionService;

  beforeEach(() => {
    prisma = {
      projectVersion: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    projects = {
      findOne: jest.fn().mockResolvedValue({ id: "proj_1" }),
      ensureEditable: jest.fn().mockResolvedValue({ id: "proj_1" }),
    };
    service = new CompositionService(prisma as unknown as PrismaService, projects as unknown as ProjectsService);
  });

  describe("get", () => {
    it("returns the latest version's composition", async () => {
      const composition = buildComposition();
      prisma.projectVersion.findFirst.mockResolvedValue({ id: "ver_1", composition, createdAt: new Date() });

      const result = await service.get("user_1", "proj_1");

      expect(projects.findOne).toHaveBeenCalledWith("user_1", "proj_1");
      expect(result.versionId).toBe("ver_1");
      expect(result.composition).toEqual(composition);
    });

    it("404s when the project has no version yet", async () => {
      prisma.projectVersion.findFirst.mockResolvedValue(null);

      await expect(service.get("user_1", "proj_1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("save", () => {
    it("requires edit permission before writing", async () => {
      const composition = buildComposition();
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_2", composition, createdAt: new Date() });

      await service.save("user_1", "proj_1", composition);

      expect(projects.ensureEditable).toHaveBeenCalledWith("user_1", "proj_1");
      expect(prisma.projectVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ projectId: "proj_1", composition }) }),
      );
    });

    it("accepts an empty clip list", async () => {
      const composition = buildComposition({ clips: [] });
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_2b", composition, createdAt: new Date() });

      await expect(service.save("user_1", "proj_1", composition)).resolves.toBeDefined();
    });

    it("rejects a composition missing required fields", async () => {
      await expect(service.save("user_1", "proj_1", { schemaVersion: "2.0" })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.projectVersion.create).not.toHaveBeenCalled();
    });

    it("fills in defaults for a clip that only specifies its required fields", async () => {
      const composition = {
        ...buildComposition(),
        clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000 }],
      };
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_3", composition, createdAt: new Date() });

      await service.save("user_1", "proj_1", composition);

      const savedClip = prisma.projectVersion.create.mock.calls[0][0].data.composition.clips[0];
      expect(savedClip).toMatchObject({ trimInMs: 0, trimOutMs: 0, volume: 1, muted: false, speedPercent: 100 });
      expect(savedClip.transform).toEqual({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
    });

    it("rejects a clip with a negative trim offset", async () => {
      const composition = {
        ...buildComposition(),
        clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000, trimInMs: -100 }],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a clip missing its mediaAssetId", async () => {
      const composition = { ...buildComposition(), clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", startMs: 0, durationMs: 1000 }] };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a volume outside the 0-2 range", async () => {
      const composition = {
        ...buildComposition(),
        clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000, volume: 3 }],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a clip that references a track that doesn't exist", async () => {
      const composition = {
        ...buildComposition(),
        clips: [{ id: "clip_1", trackId: "missing_track", kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000 }],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a clip whose kind doesn't match its track's kind", async () => {
      const composition = {
        ...buildComposition(),
        tracks: [{ id: TRACK_ID, kind: "audio", name: "Music", order: 0, locked: false, hidden: false, muted: false, solo: false }],
        clips: [{ id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000 }],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects two clips overlapping in time on the same track", async () => {
      const composition = {
        ...buildComposition(),
        clips: [
          { id: "clip_1", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 1000 },
          { id: "clip_2", trackId: TRACK_ID, kind: "video", mediaAssetId: "med_2", startMs: 500, durationMs: 1000 },
        ],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("allows clips on different tracks to overlap in time — that's compositing, not a conflict", async () => {
      const composition = {
        ...buildComposition(),
        tracks: [
          { id: "v1", kind: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, solo: false },
          { id: "v2", kind: "overlay", name: "Logo", order: 1, locked: false, hidden: false, muted: false, solo: false },
        ],
        clips: [
          { id: "clip_1", trackId: "v1", kind: "video", mediaAssetId: "med_1", startMs: 0, durationMs: 5000 },
          { id: "clip_2", trackId: "v2", kind: "overlay", mediaAssetId: "med_2", startMs: 1000, durationMs: 2000 },
        ],
      };
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_5", composition, createdAt: new Date() });

      await expect(service.save("user_1", "proj_1", composition)).resolves.toBeDefined();
    });
  });
});

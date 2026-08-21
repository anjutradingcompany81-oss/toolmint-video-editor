import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CompositionService } from "./composition.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "./projects.service";
import type { Composition } from "./composition.schema";

function buildComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    schemaVersion: "1.0",
    clips: [{ id: "clip_1", mediaAssetId: "med_1", trimInMs: 0, trimOutMs: 0, volume: 1, muted: false }],
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
      await expect(service.save("user_1", "proj_1", { schemaVersion: "1.0" })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.projectVersion.create).not.toHaveBeenCalled();
    });

    it("fills in defaults for a clip that only specifies id and mediaAssetId", async () => {
      const composition = { ...buildComposition(), clips: [{ id: "clip_1", mediaAssetId: "med_1" }] };
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_3", composition, createdAt: new Date() });

      await service.save("user_1", "proj_1", composition);

      const savedClip = prisma.projectVersion.create.mock.calls[0][0].data.composition.clips[0];
      expect(savedClip).toMatchObject({ trimInMs: 0, trimOutMs: 0, volume: 1, muted: false });
    });

    it("rejects a clip with a negative trim offset", async () => {
      const composition = { ...buildComposition(), clips: [{ id: "clip_1", mediaAssetId: "med_1", trimInMs: -100 }] };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a clip missing its mediaAssetId", async () => {
      const composition = { ...buildComposition(), clips: [{ id: "clip_1" }] };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a volume outside the 0-2 range", async () => {
      const composition = { ...buildComposition(), clips: [{ id: "clip_1", mediaAssetId: "med_1", volume: 3 }] };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("preserves clip array order (order is timeline order)", async () => {
      const composition = {
        ...buildComposition(),
        clips: [
          { id: "clip_1", mediaAssetId: "med_1" },
          { id: "clip_2", mediaAssetId: "med_2" },
        ],
      };
      prisma.projectVersion.create.mockResolvedValue({ id: "ver_4", composition, createdAt: new Date() });

      await service.save("user_1", "proj_1", composition);

      const savedClips = prisma.projectVersion.create.mock.calls[0][0].data.composition.clips;
      expect(savedClips.map((c: { id: string }) => c.id)).toEqual(["clip_1", "clip_2"]);
    });
  });
});

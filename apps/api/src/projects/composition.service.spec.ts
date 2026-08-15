import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CompositionService } from "./composition.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { ProjectsService } from "./projects.service";
import type { Composition } from "./composition.schema";

function buildComposition(overrides: Partial<Composition> = {}): Composition {
  return {
    schemaVersion: "1.0",
    aspectRatio: "RATIO_16_9",
    fps: 30,
    scenes: [{ id: "scn_1", name: "Intro", durationMs: 5000, tracks: [] }],
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

    it("rejects a composition missing required fields", async () => {
      await expect(service.save("user_1", "proj_1", { schemaVersion: "1.0" })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.projectVersion.create).not.toHaveBeenCalled();
    });

    it("rejects a scene with a non-positive duration", async () => {
      const composition = buildComposition({ scenes: [{ id: "scn_1", name: "Intro", durationMs: 0, tracks: [] }] });

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an unknown track type", async () => {
      const composition = {
        ...buildComposition(),
        scenes: [
          {
            id: "scn_1",
            name: "Intro",
            durationMs: 5000,
            tracks: [{ id: "trk_1", type: "hologram", locked: false, muted: false, items: [] }],
          },
        ],
      };

      await expect(service.save("user_1", "proj_1", composition)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

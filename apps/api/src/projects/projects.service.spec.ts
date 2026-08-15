import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { MembershipRole, ProjectAspectRatio } from "@prisma/client";
import { ProjectsService } from "./projects.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";

interface PrismaMock {
  project: { create: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock; delete: jest.Mock };
  projectVersion: { create: jest.Mock; findFirst: jest.Mock };
  membership: { findUnique: jest.Mock; findMany: jest.Mock };
  mediaAsset: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function buildPrismaMock(): PrismaMock {
  const prisma: PrismaMock = {
    project: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    projectVersion: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn() },
    membership: { findUnique: jest.fn(), findMany: jest.fn() },
    mediaAsset: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return (arg as (tx: PrismaMock) => unknown)(prisma);
    return Promise.all(arg as Promise<unknown>[]);
  });
  return prisma;
}

function buildProject(overrides: Partial<{ id: string; workspaceId: string; title: string }> = {}) {
  return {
    id: overrides.id ?? "proj_1",
    workspaceId: overrides.workspaceId ?? "ws_1",
    title: overrides.title ?? "My Video",
    aspectRatio: ProjectAspectRatio.RATIO_16_9,
    customWidth: null,
    customHeight: null,
    fps: 30,
    thumbnailUrl: null,
    isArchived: false,
    createdById: "user_1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("ProjectsService", () => {
  let prisma: PrismaMock;
  let storage: jest.Mocked<Pick<StorageService, "delete">>;
  let service: ProjectsService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    storage = { delete: jest.fn().mockResolvedValue(undefined) };
    service = new ProjectsService(prisma as unknown as PrismaService, storage as unknown as StorageService);
  });

  describe("create", () => {
    it("creates a project and an initial version in the caller's default workspace", async () => {
      prisma.membership.findMany.mockResolvedValue([{ workspaceId: "ws_1" }]);
      prisma.project.create.mockResolvedValue(buildProject());

      const result = await service.create("user_1", { title: "My Video" });

      expect(prisma.project.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: "ws_1", title: "My Video" }) }));
      expect(prisma.projectVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ label: "Initial version" }) }),
      );
      expect(result.title).toBe("My Video");
    });

    it("rejects a custom aspect ratio without dimensions", async () => {
      prisma.membership.findMany.mockResolvedValue([{ workspaceId: "ws_1" }]);

      await expect(service.create("user_1", { title: "My Video", aspectRatio: ProjectAspectRatio.CUSTOM })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.project.create).not.toHaveBeenCalled();
    });

    it("throws when the caller has no workspace at all", async () => {
      prisma.membership.findMany.mockResolvedValue([]);

      await expect(service.create("user_1", { title: "My Video" })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("findOne", () => {
    it("returns the project for a member", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue({ role: MembershipRole.VIEWER });

      const project = await service.findOne("user_1", "proj_1");
      expect(project.id).toBe("proj_1");
    });

    it("404s for a non-member instead of leaking that the project exists", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue(null);

      await expect(service.findOne("stranger", "proj_1")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s for an unknown project id", async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(service.findOne("user_1", "missing")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("update", () => {
    it("rejects a viewer trying to rename the project", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue({ role: MembershipRole.VIEWER });

      await expect(service.update("user_1", "proj_1", { title: "New title" })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.project.update).not.toHaveBeenCalled();
    });

    it("allows an editor to rename the project", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue({ role: MembershipRole.EDITOR });
      prisma.project.update.mockResolvedValue(buildProject({ title: "New title" }));

      const result = await service.update("user_1", "proj_1", { title: "New title" });
      expect(result.title).toBe("New title");
    });
  });

  describe("duplicate", () => {
    it("copies the latest composition into a new project", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue({ role: MembershipRole.OWNER });
      prisma.projectVersion.findFirst.mockResolvedValue({ composition: { schemaVersion: "1.0", scenes: [{ id: "scn_1" }] } });
      prisma.project.create.mockResolvedValue(buildProject({ id: "proj_2", title: "My Video (Copy)" }));

      const copy = await service.duplicate("user_1", "proj_1");

      expect(copy.title).toBe("My Video (Copy)");
      expect(prisma.projectVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ composition: { schemaVersion: "1.0", scenes: [{ id: "scn_1" }] } }),
        }),
      );
    });
  });

  describe("remove", () => {
    it("deletes stored media objects before deleting the project", async () => {
      prisma.project.findUnique.mockResolvedValue(buildProject());
      prisma.membership.findUnique.mockResolvedValue({ role: MembershipRole.OWNER });
      prisma.mediaAsset.findMany.mockResolvedValue([{ storageKey: "projects/proj_1/a/file.mp4" }]);

      await service.remove("user_1", "proj_1");

      expect(storage.delete).toHaveBeenCalledWith("projects/proj_1/a/file.mp4");
      expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: "proj_1" } });
    });
  });
});

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MembershipRole, ProjectAspectRatio } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { buildEmptyComposition } from "./composition.util";

const READ_ONLY_ROLES: MembershipRole[] = [MembershipRole.VIEWER, MembershipRole.REVIEWER];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(userId: string, dto: CreateProjectDto) {
    const workspaceId = await this.resolveWorkspaceId(userId, dto.workspaceId);
    const aspectRatio = dto.aspectRatio ?? ProjectAspectRatio.RATIO_16_9;

    if (aspectRatio === ProjectAspectRatio.CUSTOM && (!dto.customWidth || !dto.customHeight)) {
      throw new BadRequestException("customWidth and customHeight are required for a custom aspect ratio");
    }

    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          workspaceId,
          title: dto.title,
          aspectRatio,
          customWidth: aspectRatio === ProjectAspectRatio.CUSTOM ? dto.customWidth : null,
          customHeight: aspectRatio === ProjectAspectRatio.CUSTOM ? dto.customHeight : null,
          fps: dto.fps ?? 30,
          createdById: userId,
        },
      });
      await tx.projectVersion.create({
        data: {
          projectId: project.id,
          createdById: userId,
          label: "Initial version",
          composition: buildEmptyComposition(project),
        },
      });
      return project;
    });
  }

  async list(userId: string, options: { includeArchived: boolean; search?: string }) {
    const workspaceIds = await this.workspaceIdsFor(userId);
    return this.prisma.project.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        ...(options.includeArchived ? {} : { isArchived: false }),
        ...(options.search ? { title: { contains: options.search, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async findOne(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");
    await this.assertMember(userId, project.workspaceId);
    return project;
  }

  async update(userId: string, projectId: string, dto: UpdateProjectDto) {
    const project = await this.ensureEditable(userId, projectId);
    return this.prisma.project.update({ where: { id: project.id }, data: dto });
  }

  async duplicate(userId: string, projectId: string) {
    const project = await this.findOne(userId, projectId);
    const latestVersion = await this.prisma.projectVersion.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
    });

    return this.prisma.$transaction(async (tx) => {
      const copy = await tx.project.create({
        data: {
          workspaceId: project.workspaceId,
          title: `${project.title} (Copy)`,
          aspectRatio: project.aspectRatio,
          customWidth: project.customWidth,
          customHeight: project.customHeight,
          fps: project.fps,
          createdById: userId,
        },
      });
      await tx.projectVersion.create({
        data: {
          projectId: copy.id,
          createdById: userId,
          label: "Duplicated version",
          composition: latestVersion?.composition ?? buildEmptyComposition(copy),
        },
      });
      return copy;
    });
  }

  async remove(userId: string, projectId: string): Promise<void> {
    const project = await this.ensureEditable(userId, projectId);

    const assets = await this.prisma.mediaAsset.findMany({
      where: { projectId: project.id },
      select: { storageKey: true },
    });
    // Best-effort: a stray object left behind in the bucket after a DB row
    // is gone is a cleanup problem; an orphaned DB row pointing at a
    // deleted-but-still-billed object is worse, so the DB delete proceeds
    // either way.
    await Promise.all(assets.map((asset) => this.storage.delete(asset.storageKey).catch(() => undefined)));

    await this.prisma.project.delete({ where: { id: project.id } });
  }

  // Shared with MediaModule: uploading/deleting media on a project requires
  // the same edit permission as renaming or archiving it.
  async ensureEditable(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");

    const membership = await this.assertMember(userId, project.workspaceId);
    if (READ_ONLY_ROLES.includes(membership.role)) {
      throw new ForbiddenException("You don't have permission to modify this project");
    }
    return project;
  }

  private async assertMember(userId: string, workspaceId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    // 404, not 403: a non-member shouldn't learn the project exists at all.
    if (!membership) throw new NotFoundException("Project not found");
    return membership;
  }

  private async workspaceIdsFor(userId: string): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({ where: { userId }, select: { workspaceId: true } });
    return memberships.map((m) => m.workspaceId);
  }

  private async resolveWorkspaceId(userId: string, requested: string | undefined): Promise<string> {
    if (requested) {
      await this.assertMember(userId, requested);
      return requested;
    }
    const [membership] = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      take: 1,
    });
    if (!membership) throw new NotFoundException("No workspace found for this user");
    return membership.workspaceId;
  }
}

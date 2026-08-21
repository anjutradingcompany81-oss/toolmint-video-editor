import { randomUUID } from "crypto";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MembershipRole, Project } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { buildEmptyComposition } from "./composition.util";

const READ_ONLY_ROLES: MembershipRole[] = [MembershipRole.VIEWER, MembershipRole.REVIEWER];
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export interface ProjectResponse extends Omit<Project, "thumbnailKey"> {
  thumbnailUrl: string | null;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(userId: string, dto: CreateProjectDto): Promise<ProjectResponse> {
    const workspaceId = await this.resolveWorkspaceId(userId, dto.workspaceId);

    const project = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          workspaceId,
          title: dto.title,
          fps: dto.fps ?? 30,
          createdById: userId,
        },
      });
      await tx.projectVersion.create({
        data: {
          projectId: project.id,
          createdById: userId,
          label: "Initial version",
          composition: buildEmptyComposition(),
        },
      });
      return project;
    });
    return this.toResponse(project);
  }

  async list(userId: string, options: { includeArchived: boolean; search?: string }): Promise<ProjectResponse[]> {
    const workspaceIds = await this.workspaceIdsFor(userId);
    const projects = await this.prisma.project.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        ...(options.includeArchived ? {} : { isArchived: false }),
        ...(options.search ? { title: { contains: options.search, mode: "insensitive" } } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(projects.map((p) => this.toResponse(p)));
  }

  async findOne(userId: string, projectId: string): Promise<ProjectResponse> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found");
    await this.assertMember(userId, project.workspaceId);
    return this.toResponse(project);
  }

  async update(userId: string, projectId: string, dto: UpdateProjectDto): Promise<ProjectResponse> {
    const project = await this.ensureEditable(userId, projectId);
    const updated = await this.prisma.project.update({ where: { id: project.id }, data: dto });
    return this.toResponse(updated);
  }

  // Generated client-side from the editor's own preview canvas — it already
  // renders exactly what the timeline currently shows, so this reuses that
  // instead of standing up a separate server-side rendering path just for a
  // thumbnail. Best-effort: a project without one yet just shows a
  // placeholder in the dashboard grid, never blocks anything.
  async setThumbnail(userId: string, projectId: string, buffer: Buffer, mimeType: string): Promise<ProjectResponse> {
    const project = await this.ensureEditable(userId, projectId);
    if (buffer.length > THUMBNAIL_MAX_BYTES) {
      throw new BadRequestException(`Thumbnails are limited to ${Math.floor(THUMBNAIL_MAX_BYTES / 1024)}KB`);
    }

    const previousKey = project.thumbnailKey;
    const thumbnailKey = `projects/${project.id}/thumbnail-${randomUUID()}.jpg`;
    await this.storage.putObject(thumbnailKey, buffer, mimeType);
    const updated = await this.prisma.project.update({ where: { id: project.id }, data: { thumbnailKey } });
    if (previousKey) await this.storage.delete(previousKey).catch(() => undefined);

    return this.toResponse(updated);
  }

  async duplicate(userId: string, projectId: string): Promise<ProjectResponse> {
    const project = await this.findOne(userId, projectId);
    const latestVersion = await this.prisma.projectVersion.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
    });

    const copy = await this.prisma.$transaction(async (tx) => {
      const copy = await tx.project.create({
        data: {
          workspaceId: project.workspaceId,
          title: `${project.title} (Copy)`,
          fps: project.fps,
          createdById: userId,
        },
      });
      await tx.projectVersion.create({
        data: {
          projectId: copy.id,
          createdById: userId,
          label: "Duplicated version",
          composition: latestVersion?.composition ?? buildEmptyComposition(),
        },
      });
      return copy;
    });
    return this.toResponse(copy);
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
    if (project.thumbnailKey) await this.storage.delete(project.thumbnailKey).catch(() => undefined);

    await this.prisma.project.delete({ where: { id: project.id } });
  }

  private async toResponse(project: Project): Promise<ProjectResponse> {
    const { thumbnailKey, ...rest } = project;
    const thumbnailUrl = thumbnailKey ? await this.storage.presignDownload(thumbnailKey) : null;
    return { ...rest, thumbnailUrl };
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

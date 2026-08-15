import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "./projects.service";
import { compositionSchema } from "./composition.schema";

export interface CompositionEnvelope {
  versionId: string;
  composition: unknown;
  updatedAt: Date;
}

@Injectable()
export class CompositionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async get(userId: string, projectId: string): Promise<CompositionEnvelope> {
    await this.projects.findOne(userId, projectId);

    const version = await this.prisma.projectVersion.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    if (!version) throw new NotFoundException("No composition found for this project");

    return { versionId: version.id, composition: version.composition, updatedAt: version.createdAt };
  }

  // Autosave creates a new ProjectVersion per save rather than mutating one
  // in place — cheap at MVP save frequency, and it makes "restore an earlier
  // version" (Phase 4) a read over existing rows instead of a schema change.
  async save(userId: string, projectId: string, rawComposition: unknown): Promise<CompositionEnvelope> {
    await this.projects.ensureEditable(userId, projectId);

    const parsed = compositionSchema.safeParse(rawComposition);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      throw new BadRequestException(`Invalid composition: ${detail}`);
    }

    const version = await this.prisma.projectVersion.create({
      data: { projectId, createdById: userId, composition: parsed.data as unknown as Prisma.InputJsonValue },
    });

    return { versionId: version.id, composition: version.composition, updatedAt: version.createdAt };
  }
}

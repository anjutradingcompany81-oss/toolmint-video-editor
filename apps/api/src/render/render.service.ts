import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ExportJob, ExportResolution } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "../projects/projects.service";
import { StorageService } from "../storage/storage.service";
import { RENDER_QUEUE } from "./render.constants";

export interface ExportJobResponse extends ExportJob {
  downloadUrl: string | null;
}

@Injectable()
export class RenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly storage: StorageService,
    @Inject(RENDER_QUEUE) private readonly queue: Queue<{ exportJobId: string }>,
  ) {}

  async createExport(userId: string, projectId: string, sceneId: string, resolution: ExportResolution): Promise<ExportJobResponse> {
    await this.projects.ensureEditable(userId, projectId);

    const job = await this.prisma.exportJob.create({
      data: { projectId, sceneId, resolution, requestedById: userId },
    });

    await this.queue.add("render-scene", { exportJobId: job.id }, { jobId: job.id, removeOnComplete: true, removeOnFail: true });

    return this.toResponse(job);
  }

  async list(userId: string, projectId: string): Promise<ExportJobResponse[]> {
    await this.projects.findOne(userId, projectId);
    const jobs = await this.prisma.exportJob.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
    return Promise.all(jobs.map((j) => this.toResponse(j)));
  }

  async get(userId: string, projectId: string, jobId: string): Promise<ExportJobResponse> {
    await this.projects.findOne(userId, projectId);
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException("Export job not found");
    return this.toResponse(job);
  }

  private async toResponse(job: ExportJob): Promise<ExportJobResponse> {
    const downloadUrl = job.status === "COMPLETED" && job.outputStorageKey ? await this.storage.presignDownload(job.outputStorageKey) : null;
    return { ...job, downloadUrl };
  }
}

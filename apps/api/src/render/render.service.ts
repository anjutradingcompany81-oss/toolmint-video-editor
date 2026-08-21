import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ExportJob, ExportQuality, ExportResolution, ExportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ProjectsService } from "../projects/projects.service";
import { StorageService } from "../storage/storage.service";
import { sanitizeFileName } from "../media/media.constants";
import { RENDER_QUEUE } from "./render.constants";

export interface ExportJobResponse extends ExportJob {
  downloadUrl: string | null;
}

// Only one export can be in flight per project at a time — the render
// worker itself runs at concurrency 1, so a second queued job would just
// sit there, and letting the UI fire off duplicates makes "Export" feel
// broken rather than busy.
const ACTIVE_STATUSES: ExportStatus[] = [ExportStatus.QUEUED, ExportStatus.PROCESSING, ExportStatus.UPLOADING];

@Injectable()
export class RenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly storage: StorageService,
    @Inject(RENDER_QUEUE) private readonly queue: Queue<{ exportJobId: string }>,
  ) {}

  async createExport(
    userId: string,
    projectId: string,
    resolution: ExportResolution,
    quality: ExportQuality | undefined,
    outputFileName: string | undefined,
  ): Promise<ExportJobResponse> {
    await this.projects.ensureEditable(userId, projectId);

    const active = await this.prisma.exportJob.findFirst({ where: { projectId, status: { in: ACTIVE_STATUSES } } });
    if (active) throw new BadRequestException("An export is already in progress for this project");

    const job = await this.prisma.exportJob.create({
      data: {
        projectId,
        resolution,
        quality: quality ?? ExportQuality.STANDARD,
        outputFileName: outputFileName ? sanitizeFileName(outputFileName) : null,
        requestedById: userId,
      },
    });

    await this.queue.add("render-export", { exportJobId: job.id }, { jobId: job.id, removeOnComplete: true, removeOnFail: true });

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

  async cancel(userId: string, projectId: string, jobId: string): Promise<ExportJobResponse> {
    await this.projects.ensureEditable(userId, projectId);
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.projectId !== projectId) throw new NotFoundException("Export job not found");
    if (!ACTIVE_STATUSES.includes(job.status)) return this.toResponse(job);

    const updated = await this.prisma.exportJob.update({ where: { id: jobId }, data: { cancelRequested: true } });
    return this.toResponse(updated);
  }

  private async toResponse(job: ExportJob): Promise<ExportJobResponse> {
    const downloadUrl = job.status === "COMPLETED" && job.outputStorageKey ? await this.storage.presignDownload(job.outputStorageKey) : null;
    return { ...job, downloadUrl };
  }
}

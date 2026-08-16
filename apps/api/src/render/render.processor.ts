import { spawn } from "child_process";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type Redis from "ioredis";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { ExportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compositionSchema, type Scene, type TimelineItem } from "../projects/composition.schema";
import { RENDER_QUEUE_NAME, REDIS_CONNECTION } from "./render.constants";
import { buildFfmpegArgs, checkContiguous, computeDimensions, type AudioSegment, type VideoSegment } from "./ffmpeg-command.util";

@Injectable()
export class RenderProcessor implements OnModuleDestroy {
  private readonly logger = new Logger("RenderProcessor");
  private readonly worker: Worker<{ exportJobId: string }>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(REDIS_CONNECTION) connection: Redis,
  ) {
    this.worker = new Worker(RENDER_QUEUE_NAME, (job) => this.process(job), { connection, concurrency: 1 });
    this.worker.on("failed", (job, err) => this.logger.error(`Render job ${job?.id} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
  }

  private async process(job: Job<{ exportJobId: string }>): Promise<void> {
    const exportJob = await this.prisma.exportJob.findUnique({ where: { id: job.data.exportJobId } });
    if (!exportJob) return;

    const workDir = await mkdtemp(join(tmpdir(), "toolmint-render-"));
    try {
      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 5);

      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: exportJob.projectId } });
      const version = await this.prisma.projectVersion.findFirst({
        where: { projectId: exportJob.projectId },
        orderBy: { createdAt: "desc" },
      });
      if (!version) throw new Error("Project has no saved composition");

      const composition = compositionSchema.parse(version.composition);
      const scene = composition.scenes.find((s) => s.id === exportJob.sceneId);
      if (!scene) throw new Error("Scene not found in the current composition");

      const { videoTrack, audioTrack } = this.pickTracks(scene);

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 15);

      const mediaAssetIds = [...videoTrack.items, ...(audioTrack?.items ?? [])].map((i) => i.mediaAssetId);
      const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
      const assetById = new Map(assets.map((a) => [a.id, a]));

      const videoSegments: VideoSegment[] = [];
      for (const [index, item] of this.sortByStart(videoTrack.items).entries()) {
        const asset = assetById.get(item.mediaAssetId);
        if (!asset) throw new Error(`Media asset ${item.mediaAssetId} not found`);
        const localPath = join(workDir, `v${index}${extname(asset.storageKey) || ".bin"}`);
        await this.storage.downloadToFile(asset.storageKey, localPath);
        videoSegments.push({
          localPath,
          kind: asset.kind === "IMAGE" ? "image" : "video",
          trimInMs: item.trimInMs,
          durationMs: item.durationMs,
        });
      }

      const audioSegments: AudioSegment[] = [];
      if (audioTrack) {
        for (const [index, item] of this.sortByStart(audioTrack.items).entries()) {
          const asset = assetById.get(item.mediaAssetId);
          if (!asset) throw new Error(`Media asset ${item.mediaAssetId} not found`);
          const localPath = join(workDir, `a${index}${extname(asset.storageKey) || ".bin"}`);
          await this.storage.downloadToFile(asset.storageKey, localPath);
          audioSegments.push({ localPath, trimInMs: item.trimInMs, durationMs: item.durationMs });
        }
      }

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 40);

      const { width, height } = computeDimensions(project.aspectRatio, exportJob.resolution, project.customWidth, project.customHeight);
      const outputPath = join(workDir, "output.mp4");
      const args = buildFfmpegArgs({ video: videoSegments, audio: audioSegments, width, height, fps: project.fps, outputPath });

      await this.runFfmpeg(args);
      await this.setStatus(exportJob.id, ExportStatus.UPLOADING, 90);

      const outputKey = `exports/${exportJob.projectId}/${exportJob.id}.mp4`;
      await this.storage.putObjectFromFile(outputKey, outputPath, "video/mp4");
      const outputSize = (await stat(outputPath)).size;

      await this.prisma.exportJob.update({
        where: { id: exportJob.id },
        data: {
          status: ExportStatus.COMPLETED,
          progress: 100,
          outputStorageKey: outputKey,
          outputByteSize: outputSize,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Render failed";
      await this.prisma.exportJob.update({ where: { id: exportJob.id }, data: { status: ExportStatus.FAILED, errorMessage: message } });
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  // Scoped to one video track + at most one audio track — see the README
  // for why (no layering/overlay compositing yet).
  private pickTracks(scene: Scene): { videoTrack: Scene["tracks"][number]; audioTrack: Scene["tracks"][number] | undefined } {
    const videoTrack = scene.tracks.find((t) => t.type === "video" && t.items.length > 0);
    if (!videoTrack) throw new Error("This scene has no video clips to render");
    const contiguity = checkContiguous(videoTrack.items);
    if (!contiguity.ok) throw new Error(contiguity.reason);

    const audioTrack = scene.tracks.find((t) => t.type === "audio" && t.items.length > 0);
    if (audioTrack) {
      const audioContiguity = checkContiguous(audioTrack.items);
      if (!audioContiguity.ok) throw new Error(`Audio track: ${audioContiguity.reason}`);
    }

    return { videoTrack, audioTrack };
  }

  private sortByStart(items: TimelineItem[]): TimelineItem[] {
    return [...items].sort((a, b) => a.startMs - b.startMs);
  }

  private setStatus(id: string, status: ExportStatus, progress: number) {
    return this.prisma.exportJob.update({ where: { id }, data: { status, progress } });
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegInstaller.path, args);
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }
}

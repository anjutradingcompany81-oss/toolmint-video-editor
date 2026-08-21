import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type Redis from "ioredis";
import ffmpegPath from "ffmpeg-static";
import { ExportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compositionSchema } from "../projects/composition.schema";
import { RENDER_QUEUE_NAME, REDIS_CONNECTION } from "./render.constants";
import { buildMergeArgs, computeDimensions, playableDurationMs, type ClipSegment, type Resolution } from "./merge-ffmpeg.util";

// How often the worker checks whether the user clicked Cancel while ffmpeg
// is running — not instant, but bounded, and cheap enough not to matter at
// this concurrency.
const CANCEL_POLL_MS = 1000;

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

    const workDir = await mkdtemp(join(tmpdir(), "procut-render-"));
    try {
      if (await this.isCancelled(exportJob.id)) return this.markCancelled(exportJob.id);
      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 5);

      const version = await this.prisma.projectVersion.findFirst({
        where: { projectId: exportJob.projectId },
        orderBy: { createdAt: "desc" },
      });
      if (!version) throw new Error("Project has no saved timeline");

      const timeline = compositionSchema.parse(version.composition);
      if (timeline.clips.length === 0) throw new Error("Add at least one clip to the timeline before exporting");

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 15);

      const mediaAssetIds = timeline.clips.map((c) => c.mediaAssetId);
      const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
      const assetById = new Map(assets.map((a) => [a.id, a]));

      const segments: ClipSegment[] = [];
      for (const [index, clip] of timeline.clips.entries()) {
        const asset = assetById.get(clip.mediaAssetId);
        if (!asset) throw new Error(`A clip references media that no longer exists`);
        if (asset.durationMs == null) throw new Error(`"${asset.originalName}" couldn't be measured — try re-uploading it`);

        const localPath = join(workDir, `clip${index}${extname(asset.storageKey) || ".bin"}`);
        await this.storage.downloadToFile(asset.storageKey, localPath);
        segments.push({
          localPath,
          trimInMs: clip.trimInMs,
          trimOutMs: clip.trimOutMs,
          sourceDurationMs: asset.durationMs,
          hasAudio: asset.hasAudio,
          volume: clip.volume,
          muted: clip.muted,
        });

        if (await this.isCancelled(exportJob.id)) return this.markCancelled(exportJob.id);
        await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 15 + Math.round((25 * (index + 1)) / timeline.clips.length));
      }

      const firstAsset = assetById.get(timeline.clips[0].mediaAssetId)!;
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: exportJob.projectId } });
      const { width, height } = computeDimensions(exportJob.resolution as Resolution, firstAsset.width ?? 1280, firstAsset.height ?? 720);

      const outputPath = join(workDir, "output.mp4");
      const args = buildMergeArgs({ clips: segments, width, height, fps: project.fps, quality: exportJob.quality, outputPath });

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 45);
      const totalDurationMs = segments.reduce((sum, s) => sum + playableDurationMs(s), 0);
      const cancelled = await this.runFfmpeg(
        args,
        totalDurationMs,
        (progress) => this.setStatus(exportJob.id, ExportStatus.PROCESSING, 45 + Math.round(progress * 40)),
        () => this.isCancelled(exportJob.id),
      );
      if (cancelled) return this.markCancelled(exportJob.id);

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
      const message = err instanceof Error ? err.message : "Export failed";
      await this.prisma.exportJob.update({ where: { id: exportJob.id }, data: { status: ExportStatus.FAILED, errorMessage: message } });
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async isCancelled(exportJobId: string): Promise<boolean> {
    const job = await this.prisma.exportJob.findUnique({ where: { id: exportJobId }, select: { cancelRequested: true } });
    return job?.cancelRequested ?? false;
  }

  private async markCancelled(exportJobId: string): Promise<void> {
    await this.prisma.exportJob.update({ where: { id: exportJobId }, data: { status: ExportStatus.CANCELLED } });
  }

  private setStatus(id: string, status: ExportStatus, progress: number) {
    return this.prisma.exportJob.update({ where: { id }, data: { status, progress } });
  }

  // Resolves `true` if the job was cancelled mid-render (caller should stop,
  // not treat this as a failure), `false` on a normal successful exit.
  // Parses ffmpeg's own stderr `time=` progress lines against the known
  // total duration for real percentage updates instead of a fake ramp.
  private runFfmpeg(
    args: string[],
    totalDurationMs: number,
    onProgress: (fraction: number) => void,
    isCancelled: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!ffmpegPath) throw new Error("No ffmpeg binary available for this platform/architecture");
    const binaryPath = ffmpegPath;

    return new Promise((resolve, reject) => {
      const proc: ChildProcessWithoutNullStreams = spawn(binaryPath, args);
      let stderr = "";
      let lastProgressAt = 0;

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (totalDurationMs <= 0) return;
        const match = /time=(\d+):(\d+):(\d+)\.(\d+)/.exec(text);
        if (!match) return;
        const [, h, m, s, cs] = match;
        const elapsedMs = (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(cs) * 10;
        const now = Date.now();
        if (now - lastProgressAt < 500) return; // don't hammer the DB on every stderr line
        lastProgressAt = now;
        onProgress(Math.min(1, elapsedMs / totalDurationMs));
      });

      const cancelTimer = setInterval(() => {
        isCancelled().then((cancelled) => {
          if (cancelled) {
            clearInterval(cancelTimer);
            proc.kill("SIGTERM");
          }
        });
      }, CANCEL_POLL_MS);

      proc.on("error", (err) => {
        clearInterval(cancelTimer);
        reject(err);
      });
      proc.on("close", (code, signal) => {
        clearInterval(cancelTimer);
        if (signal === "SIGTERM") return resolve(true);
        if (code === 0) return resolve(false);
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }
}

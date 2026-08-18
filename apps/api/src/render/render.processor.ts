import { spawn } from "child_process";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { extname, join } from "path";
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import type Redis from "ioredis";
import ffmpegPath from "ffmpeg-static";
import { ExportStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { compositionSchema, type Scene, type TimelineItem } from "../projects/composition.schema";
import { RENDER_QUEUE_NAME, REDIS_CONNECTION } from "./render.constants";
import { buildFfmpegArgs, checkContiguous, computeDimensions, type AudioSegment, type TextOverlay, type VideoSegment } from "./ffmpeg-command.util";

type ClipItem = Extract<TimelineItem, { type: "clip" }>;
type AudioItem = Extract<TimelineItem, { type: "audio" }>;
type TextItem = Extract<TimelineItem, { type: "text" }>;

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

      const { videoItems, audioItems, textItems } = this.pickTracks(scene);

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 15);

      const mediaAssetIds = [...videoItems, ...audioItems].map((i) => i.mediaAssetId);
      const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: mediaAssetIds } } });
      const assetById = new Map(assets.map((a) => [a.id, a]));

      const sortedVideoItems = this.sortByStart(videoItems);
      const videoSegments: VideoSegment[] = [];
      for (const [index, item] of sortedVideoItems.entries()) {
        const asset = assetById.get(item.mediaAssetId);
        if (!asset) throw new Error(`Media asset ${item.mediaAssetId} not found`);
        const localPath = join(workDir, `v${index}${extname(asset.storageKey) || ".bin"}`);
        await this.storage.downloadToFile(asset.storageKey, localPath);
        videoSegments.push({
          localPath,
          kind: asset.kind === "IMAGE" ? "image" : "video",
          trimInMs: item.trimInMs,
          durationMs: item.durationMs,
          transitionInMs: this.overlapWithPrevious(sortedVideoItems, index),
          transitionType: item.transitionIn,
        });
      }

      const sortedAudioItems = this.sortByStart(audioItems);
      const audioSegments: AudioSegment[] = [];
      for (const [index, item] of sortedAudioItems.entries()) {
        const asset = assetById.get(item.mediaAssetId);
        if (!asset) throw new Error(`Media asset ${item.mediaAssetId} not found`);
        const localPath = join(workDir, `a${index}${extname(asset.storageKey) || ".bin"}`);
        await this.storage.downloadToFile(asset.storageKey, localPath);
        audioSegments.push({
          localPath,
          trimInMs: item.trimInMs,
          durationMs: item.durationMs,
          transitionInMs: this.overlapWithPrevious(sortedAudioItems, index),
        });
      }

      const textOverlays: TextOverlay[] = [];
      for (const [index, item] of textItems.entries()) {
        const textFilePath = join(workDir, `text${index}.txt`);
        await writeFile(textFilePath, item.content, "utf8");
        textOverlays.push({
          textFilePath,
          startMs: item.startMs,
          durationMs: item.durationMs,
          fontSize: Math.max(1, Math.round(item.fontSize * item.transform.scale)),
          color: item.color,
          x: item.transform.x,
          y: item.transform.y,
          opacity: item.transform.opacity,
        });
      }

      await this.setStatus(exportJob.id, ExportStatus.PROCESSING, 40);

      const { width, height } = computeDimensions(project.aspectRatio, exportJob.resolution, project.customWidth, project.customHeight);
      const outputPath = join(workDir, "output.mp4");
      const args = buildFfmpegArgs({
        video: videoSegments,
        audio: audioSegments,
        text: textOverlays,
        width,
        height,
        fps: project.fps,
        outputPath,
      });

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

  // Video/audio are scoped to one track each — see the README for why (no
  // layering/overlay compositing for clips yet). Text is different: it's
  // meant to layer over the video, so every text track's items are
  // collected (not just the first) and none of them need to be contiguous —
  // overlapping captions/titles just stack in the drawtext chain.
  private pickTracks(scene: Scene): { videoItems: ClipItem[]; audioItems: AudioItem[]; textItems: TextItem[] } {
    const videoTrack = scene.tracks.find((t) => t.type === "video" && t.items.length > 0);
    if (!videoTrack) throw new Error("This scene has no video clips to render");
    const videoItems = videoTrack.items.filter((i): i is ClipItem => i.type === "clip");
    const contiguity = checkContiguous(videoItems);
    if (!contiguity.ok) throw new Error(contiguity.reason);

    const audioTrack = scene.tracks.find((t) => t.type === "audio" && t.items.length > 0);
    const audioItems = audioTrack ? audioTrack.items.filter((i): i is AudioItem => i.type === "audio") : [];
    if (audioTrack) {
      const audioContiguity = checkContiguous(audioItems);
      if (!audioContiguity.ok) throw new Error(`Audio track: ${audioContiguity.reason}`);
    }

    const textItems = scene.tracks
      .filter((t) => t.type === "text")
      .flatMap((t) => t.items)
      .filter((i): i is TextItem => i.type === "text");

    return { videoItems, audioItems, textItems };
  }

  private sortByStart<T extends { startMs: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.startMs - b.startMs);
  }

  // How far `sorted[index]` reaches back into its predecessor's tail — 0 for
  // the first item (no predecessor) or a hard cut. checkContiguous has
  // already guaranteed this can't exceed either clip's own duration.
  private overlapWithPrevious<T extends { startMs: number; durationMs: number }>(sorted: T[], index: number): number {
    if (index === 0) return 0;
    const prev = sorted[index - 1];
    return Math.max(0, prev.startMs + prev.durationMs - sorted[index].startMs);
  }

  private setStatus(id: string, status: ExportStatus, progress: number) {
    return this.prisma.exportJob.update({ where: { id }, data: { status, progress } });
  }

  private runFfmpeg(args: string[]): Promise<void> {
    if (!ffmpegPath) throw new Error("No ffmpeg binary available for this platform/architecture");
    const binaryPath = ffmpegPath;
    return new Promise((resolve, reject) => {
      const proc = spawn(binaryPath, args);
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

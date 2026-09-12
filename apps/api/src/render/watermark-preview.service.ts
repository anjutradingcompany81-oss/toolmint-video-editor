import { mkdtemp, readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { extname, join } from "path";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import { MediaAssetKind } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProjectsService } from "../projects/projects.service";
import { compositionSchema, type Clip } from "../projects/composition.schema";
import { buildWatermarkFilterParts, type WatermarkRegion } from "./watermark.util";

// Renders ONE frame with the watermark-removal filter applied, so the
// result can be seen before committing to a full export.
//
// This exists because `delogo` cannot be faked in the browser. Drawing a
// blur or a grey box over the preview would be showing the user something
// the exported file will not look like - the whole point is to see what
// the filter actually reconstructs. So the real filter is run, on the real
// frame, by the same ffmpeg build that does the export.
@Injectable()
export class WatermarkPreviewService {
  private readonly logger = new Logger(WatermarkPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly storage: StorageService,
  ) {}

  async renderFrame(userId: string, projectId: string, timeMs: number, regions: WatermarkRegion[]): Promise<Buffer> {
    await this.projects.findOne(userId, projectId);

    const version = await this.prisma.projectVersion.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } });
    if (!version) throw new BadRequestException("Save the timeline before previewing watermark removal");
    const timeline = compositionSchema.parse(version.composition);

    const trackById = new Map(timeline.tracks.map((t) => [t.id, t]));
    const videoClips = timeline.clips.filter(
      (c): c is Extract<Clip, { kind: "video" }> => c.kind === "video" && !trackById.get(c.trackId)?.hidden,
    );
    if (videoClips.length === 0) throw new BadRequestException("Add a video clip to the timeline first");

    // Which clip is on screen at this instant. Falling back to the first
    // clip keeps a preview available when the playhead sits in a gap,
    // rather than refusing with an error the user can't act on.
    const clip = videoClips.find((c) => timeMs >= c.startMs && timeMs < c.startMs + c.durationMs) ?? videoClips[0]!;

    const asset = await this.prisma.mediaAsset.findFirst({ where: { id: clip.mediaAssetId, projectId } });
    if (!asset) throw new BadRequestException("That clip's media no longer exists");
    if (asset.kind === MediaAssetKind.AUDIO) throw new BadRequestException("There is no picture to preview at this point");

    // The canvas is sized from the first clip's asset, exactly as the
    // renderer does it - the regions are in those coordinates, so the
    // frame has to be scaled the same way or the box would land somewhere
    // else in the preview than in the export.
    const firstAsset = await this.prisma.mediaAsset.findFirst({ where: { id: videoClips[0]!.mediaAssetId, projectId } });
    const canvasWidth = firstAsset?.width ?? asset.width ?? 1920;
    const canvasHeight = firstAsset?.height ?? asset.height ?? 1080;

    // Timeline time -> position inside the source file, honouring the trim.
    const sourceMs = Math.max(0, timeMs - clip.startMs + clip.trimInMs);

    const workDir = await mkdtemp(join(tmpdir(), "procut-wmpreview-"));
    try {
      const sourcePath = join(workDir, `source${extname(asset.storageKey) || ".bin"}`);
      await this.storage.downloadToFile(asset.storageKey, sourcePath);

      const outPath = join(workDir, "frame.png");
      // Scale to the canvas first so the regions' coordinates line up, then
      // run the very same graph builder the export uses - a preview drawn
      // any other way could disagree with the finished file.
      const parts = buildWatermarkFilterParts(regions, { width: canvasWidth, height: canvasHeight }, "scaled", "out");
      const graph =
        parts.length > 0
          ? `[0:v]scale=${canvasWidth}:${canvasHeight}[scaled];${parts.join(";")}`
          : `[0:v]scale=${canvasWidth}:${canvasHeight}[out]`;

      await this.runFfmpeg([
        "-y",
        "-loglevel",
        "error",
        "-ss",
        (sourceMs / 1000).toFixed(3),
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        outPath,
      ]);

      return await readFile(outPath);
    } finally {
      // Swallowed: this runs in a finally, so a failure to remove the
      // scratch directory would replace whatever real error sent us
      // here with a confusing EBUSY. A leftover temp dir is the
      // lesser problem, and matches the other processors.
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    if (!ffmpegPath) return Promise.reject(new Error("No ffmpeg binary available for this platform/architecture"));
    const binaryPath = ffmpegPath;
    return new Promise((resolve, reject) => {
      const child = spawn(binaryPath, args);
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new BadRequestException(`Couldn't render the preview frame: ${stderr.slice(0, 300)}`)),
      );
    });
  }
}

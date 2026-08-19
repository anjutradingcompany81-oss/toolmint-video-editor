import { randomUUID, createHash } from "crypto";
import { extname } from "path";
import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import { MediaAsset, MediaAssetStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProjectsService } from "../projects/projects.service";
import { MEDIA_RULES, resolveMediaKind, sanitizeFileName } from "./media.constants";
import { MediaProbeService } from "./media-probe.service";

export interface MediaAssetResponse extends MediaAsset {
  previewUrl: string | null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly probe: MediaProbeService,
  ) {}

  async upload(userId: string, projectId: string, file: Express.Multer.File): Promise<MediaAssetResponse> {
    await this.projects.ensureEditable(userId, projectId);

    const kind = resolveMediaKind(file.mimetype);
    if (!kind) throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);

    const rule = MEDIA_RULES[kind];
    if (file.size > rule.maxBytes) {
      throw new BadRequestException(`${kind.toLowerCase()} uploads are limited to ${Math.floor(rule.maxBytes / (1024 * 1024))}MB`);
    }

    const assetId = randomUUID();
    const storageKey = `projects/${projectId}/${assetId}/${sanitizeFileName(file.originalname)}`;

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        projectId,
        kind,
        status: MediaAssetStatus.UPLOADING,
        originalName: file.originalname,
        storageKey,
        mimeType: file.mimetype,
        byteSize: file.size,
        checksum: createHash("sha256").update(file.buffer).digest("hex"),
        uploadedById: userId,
      },
    });

    try {
      await this.storage.putObject(storageKey, file.buffer, file.mimetype);
    } catch {
      await this.prisma.mediaAsset.update({ where: { id: asset.id }, data: { status: MediaAssetStatus.FAILED } });
      throw new InternalServerErrorException("Upload failed while saving to storage");
    }

    // Best-effort enrichment — duration/dimensions/waveform make the editor
    // meaningfully better (real trim limits, real waveforms) but a probe
    // failure shouldn't fail the upload itself; the asset still becomes
    // READY with those fields left null.
    let probed: { durationMs: number | null; width: number | null; height: number | null; waveformPeaks: number[] | null } = {
      durationMs: null,
      width: null,
      height: null,
      waveformPeaks: null,
    };
    if (kind !== "DOCUMENT") {
      try {
        const ext = extname(file.originalname).replace(".", "") || "bin";
        probed = await this.probe.probe(file.buffer, ext, kind === "VIDEO" || kind === "AUDIO");
      } catch (err) {
        this.logger.warn(`Media probe failed for ${asset.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const ready = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        status: MediaAssetStatus.READY,
        durationMs: probed.durationMs,
        width: probed.width,
        height: probed.height,
        // Prisma's typed Json column needs the sentinel Prisma.JsonNull for
        // an actual null value — a bare `null` there means "leave the
        // column untouched," not "clear it."
        waveformPeaks: probed.waveformPeaks === null ? Prisma.JsonNull : probed.waveformPeaks,
      },
    });

    return this.toResponse(ready);
  }

  async list(userId: string, projectId: string): Promise<MediaAssetResponse[]> {
    await this.projects.findOne(userId, projectId);
    const assets = await this.prisma.mediaAsset.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
    return Promise.all(assets.map((asset) => this.toResponse(asset)));
  }

  async remove(userId: string, projectId: string, mediaAssetId: string): Promise<void> {
    await this.projects.ensureEditable(userId, projectId);

    const asset = await this.prisma.mediaAsset.findUnique({ where: { id: mediaAssetId } });
    if (!asset || asset.projectId !== projectId) throw new NotFoundException("Media asset not found");

    await this.storage.delete(asset.storageKey).catch(() => undefined);
    await this.prisma.mediaAsset.delete({ where: { id: asset.id } });
  }

  private async toResponse(asset: MediaAsset): Promise<MediaAssetResponse> {
    const previewUrl = asset.status === MediaAssetStatus.READY ? await this.storage.presignDownload(asset.storageKey) : null;
    return { ...asset, previewUrl };
  }
}

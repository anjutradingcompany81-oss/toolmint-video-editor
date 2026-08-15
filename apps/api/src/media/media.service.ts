import { randomUUID, createHash } from "crypto";
import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { MediaAsset, MediaAssetStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProjectsService } from "../projects/projects.service";
import { MEDIA_RULES, resolveMediaKind, sanitizeFileName } from "./media.constants";

export interface MediaAssetResponse extends MediaAsset {
  previewUrl: string | null;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
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

    const ready = await this.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { status: MediaAssetStatus.READY },
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

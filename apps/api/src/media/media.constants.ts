import { MediaAssetKind } from "@prisma/client";

interface MediaKindRule {
  mimeTypes: string[];
  maxBytes: number;
}

// Placeholder limits for Phase 1 — plan-based storage/quality limits (per
// the PRD's billing section) replace these once subscriptions exist.
export const MEDIA_RULES: Record<MediaAssetKind, MediaKindRule> = {
  VIDEO: { mimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"], maxBytes: 500 * 1024 * 1024 },
  IMAGE: { mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 25 * 1024 * 1024 },
  AUDIO: { mimeTypes: ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg"], maxBytes: 100 * 1024 * 1024 },
  DOCUMENT: { mimeTypes: ["application/pdf"], maxBytes: 20 * 1024 * 1024 },
};

export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MEDIA_RULES).map((rule) => rule.maxBytes));

export function resolveMediaKind(mimeType: string): MediaAssetKind | null {
  for (const kind of Object.keys(MEDIA_RULES) as MediaAssetKind[]) {
    if (MEDIA_RULES[kind].mimeTypes.includes(mimeType)) return kind;
  }
  return null;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-150) || "file";
}

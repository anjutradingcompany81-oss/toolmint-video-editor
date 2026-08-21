import { MediaAssetKind } from "@prisma/client";

interface MediaKindRule {
  mimeTypes: string[];
  maxBytes: number;
}

// ProCut only merges video — MediaAssetKind still has IMAGE/AUDIO/DOCUMENT
// (harmless to leave in the schema), but nothing in this rule set accepts
// them, so resolveMediaKind() below rejects anything that isn't video with
// a clear "unsupported file type" error rather than silently misfiling it.
export const MEDIA_RULES: Partial<Record<MediaAssetKind, MediaKindRule>> = {
  VIDEO: {
    mimeTypes: [
      "video/mp4",
      "video/quicktime", // .mov
      "video/webm",
      "video/x-matroska", // .mkv
      "video/x-msvideo", // .avi
      "video/avi",
    ],
    maxBytes: 1024 * 1024 * 1024, // 1GB — large enough for real footage, still bounded
  },
};

export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MEDIA_RULES).map((rule) => rule.maxBytes));

export function resolveMediaKind(mimeType: string): MediaAssetKind | null {
  for (const kind of Object.keys(MEDIA_RULES) as MediaAssetKind[]) {
    if (MEDIA_RULES[kind]?.mimeTypes.includes(mimeType)) return kind;
  }
  return null;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-150) || "file";
}

import { MediaAssetKind } from "@prisma/client";

interface MediaKindRule {
  mimeTypes: string[];
  maxBytes: number;
}

// IMAGE is accepted so a logo/watermark can be uploaded and composited as
// an overlay-kind clip (the render pipeline already supports overlays with
// their own position/scale/opacity — see merge-ffmpeg.util.ts). AUDIO is
// accepted for music/voice-over beds on audio-kind tracks. Both are much
// smaller than footage, so they get their own tighter size caps rather
// than sharing video's 1GB allowance.
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
  IMAGE: {
    // PNG first: a logo almost always needs transparency, which the
    // overlay filter honours via the yuva420p/colorchannelmixer chain.
    mimeTypes: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: 20 * 1024 * 1024,
  },
  AUDIO: {
    mimeTypes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/ogg", "audio/webm"],
    maxBytes: 200 * 1024 * 1024,
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

import { z } from "zod";

// v2 timeline: multiple tracks, each holding clips with an *absolute*
// timeline position (startMs) — the key change from v1's flat, position-
// less Clip[] (where array order alone was the timeline order). This is
// what makes real multitrack possible: independent tracks, gaps, and
// clips that overlap in time across different tracks.
//
// "Music" vs "Voice-over", or "Titles" vs "Captions", are deliberately
// NOT separate schema shapes — they're both just audio-kind (or
// text-kind) tracks with a different user-given name. Modeling every
// named use case as its own track type would multiply the schema for no
// functional benefit; a user can create as many tracks of a kind as they
// want and name each one whatever they want.
export const trackKindSchema = z.enum(["video", "audio", "text", "overlay"]);
export type TrackKind = z.infer<typeof trackKindSchema>;

export const trackSchema = z.object({
  id: z.string().min(1),
  kind: trackKindSchema,
  name: z.string().min(1).max(60),
  // Stacking/compositing order for visual kinds (video/text/overlay) —
  // higher order composites on top of lower. For audio kinds this only
  // affects mix ordering in the UI, not the resulting sound.
  order: z.number().int(),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
});
export type Track = z.infer<typeof trackSchema>;

const transformShape = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().positive().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
});
// Zod's `.default()` needs a literal matching the schema's *input* shape,
// not its (post-default) output — so the fallback has to spell out every
// field itself rather than relying on each field's own default to fill in
// an empty object.
const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
const transformSchema = transformShape.default(DEFAULT_TRANSFORM);
export type Transform = z.infer<typeof transformSchema>;

const baseClipFields = {
  id: z.string().min(1),
  trackId: z.string().min(1),
  // Absolute position on the timeline, in milliseconds — the whole point
  // of the v2 rebuild. Clips on different tracks can overlap in time;
  // clips on the same track must not (enforced below).
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
};

// AI Repetitive Voice Remover: a non-destructive "sub-range replace" over
// a clip's own audio, in the clip's local timeline coordinates ([0,
// durationMs) — the source file itself is never touched, this just tells
// the render pipeline "play room tone instead of the real source audio
// here". `roomToneSource*Ms` (in *source* coordinates, same space as
// trimInMs) point at a quiet, non-speech moment elsewhere in the same
// file that the render pipeline loops/crossfades to fill the gap; when
// no clean reference was found at detection time, the renderer falls
// back to soft synthesized ambience instead.
const audioPatchSchema = z
  .object({
    id: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    roomToneSourceStartMs: z.number().int().nonnegative().optional(),
    roomToneSourceEndMs: z.number().int().nonnegative().optional(),
    // Present when this patch was created from an AI scan result, absent
    // for a hand-authored patch (not currently reachable from the UI, but
    // the schema shouldn't assume every patch has one).
    repetitionResultId: z.string().optional(),
  })
  .refine((p) => p.endMs > p.startMs, { message: "endMs must be after startMs" });
export type AudioPatch = z.infer<typeof audioPatchSchema>;

// video/audio/overlay clips all reference a source MediaAsset — same
// shape, three literal `kind`s so they each work as their own branch of
// the discriminated union below (z.discriminatedUnion requires a single
// literal per branch, not an enum of several).
function mediaClipShape<K extends "video" | "audio" | "overlay">(kind: K) {
  return {
    ...baseClipFields,
    kind: z.literal(kind),
    mediaAssetId: z.string().min(1),
    // Offsets into the *source* file, same meaning as v1.
    trimInMs: z.number().int().nonnegative().default(0),
    trimOutMs: z.number().int().nonnegative().default(0),
    volume: z.number().min(0).max(2).default(1),
    muted: z.boolean().default(false),
    // 100 = normal speed — reserved for a later phase's speed control;
    // accepted and round-tripped now so the schema doesn't need another
    // breaking migration when that phase lands.
    speedPercent: z.number().int().positive().default(100),
    transform: transformSchema,
    audioPatches: z.array(audioPatchSchema).default([]),
  };
}

export const videoClipSchema = z.object(mediaClipShape("video"));
export const audioClipSchema = z.object(mediaClipShape("audio"));
export const overlayClipSchema = z.object(mediaClipShape("overlay"));
export type MediaClip = z.infer<typeof videoClipSchema | typeof audioClipSchema | typeof overlayClipSchema>;

// No mediaAssetId — content/style live on the item itself.
export const textClipSchema = z.object({
  ...baseClipFields,
  kind: z.literal("text"),
  content: z.string().min(1).max(2000),
  fontFamily: z.string().min(1).max(100).default("Inter"),
  fontSize: z.number().int().positive().max(500).default(48),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color")
    .default("#F8FAFC"),
  transform: transformSchema,
});
export type TextClip = z.infer<typeof textClipSchema>;

export const clipSchema = z.discriminatedUnion("kind", [videoClipSchema, audioClipSchema, overlayClipSchema, textClipSchema]);
export type Clip = z.infer<typeof clipSchema>;

export const TRACK_KIND_FOR_CLIP_KIND: Record<Clip["kind"], TrackKind> = {
  video: "video",
  audio: "audio",
  overlay: "overlay",
  text: "text",
};

// One caption line, in timeline-absolute ms so it lines up with what the
// preview and the renderer both already work in. Kept on the timeline
// rather than as text-kind clips because captions are a single ordered
// list the user edits as a script, and because the renderer burns them in
// via ffmpeg's subtitles filter from a generated .srt — not through the
// overlay/compositing path clips use.
export const subtitleCueSchema = z
  .object({
    id: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().max(500),
  })
  .refine((c) => c.endMs > c.startMs, { message: "endMs must be after startMs" });
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;

export const subtitleStyleSchema = z.object({
  fontSizePx: z.number().int().min(8).max(200).default(24),
  // 6-digit hex, converted to ffmpeg's &HBBGGRR ASS format at render time.
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#FFFFFF"),
  outlineHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#000000"),
  position: z.enum(["BOTTOM", "TOP"]).default("BOTTOM"),
  // Burn-in is opt-in: SRT/VTT can be exported as sidecar files without
  // permanently altering the picture.
  burnIn: z.boolean().default(false),
});
export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;

const DEFAULT_SUBTITLE_STYLE = { fontSizePx: 24, colorHex: "#FFFFFF", outlineHex: "#000000", position: "BOTTOM" as const, burnIn: false };

export const timelineSchema = z
  .object({
    schemaVersion: z.literal("2.0"),
    tracks: z.array(trackSchema).default([]),
    clips: z.array(clipSchema).default([]),
    subtitles: z.array(subtitleCueSchema).default([]),
    subtitleStyle: subtitleStyleSchema.default(DEFAULT_SUBTITLE_STYLE),
    updatedAt: z.string(),
  })
  .superRefine((timeline, ctx) => {
    const trackById = new Map(timeline.tracks.map((t) => [t.id, t]));

    // Every clip must reference a real track, of a compatible kind, and
    // clips on the *same* track must not overlap in time (that's what a
    // track is — cross-track overlap is fine, that's compositing).
    const byTrack = new Map<string, { startMs: number; endMs: number; index: number }[]>();

    timeline.clips.forEach((clip, index) => {
      const track = trackById.get(clip.trackId);
      if (!track) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index, "trackId"], message: "References a track that doesn't exist" });
        return;
      }
      if (TRACK_KIND_FOR_CLIP_KIND[clip.kind] !== track.kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips", index, "kind"],
          message: `A "${clip.kind}" clip can't be placed on a "${track.kind}" track`,
        });
        return;
      }
      const list = byTrack.get(clip.trackId) ?? [];
      list.push({ startMs: clip.startMs, endMs: clip.startMs + clip.durationMs, index });
      byTrack.set(clip.trackId, list);

      if (clip.kind !== "text") {
        const patches = [...clip.audioPatches].sort((a, b) => a.startMs - b.startMs);
        for (let i = 0; i < patches.length; i++) {
          if (patches[i].endMs > clip.durationMs) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index, "audioPatches"], message: "An audio patch extends past the end of its clip" });
          }
          if (i > 0 && patches[i].startMs < patches[i - 1].endMs) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clips", index, "audioPatches"], message: "Audio patches on the same clip overlap" });
          }
        }
      }
    });

    for (const clips of byTrack.values()) {
      clips.sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < clips.length; i++) {
        if (clips[i].startMs < clips[i - 1].endMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["clips", clips[i].index, "startMs"],
            message: "Overlaps another clip on the same track",
          });
        }
      }
    }
  });
export type Timeline = z.infer<typeof timelineSchema>;

export interface TimelineEnvelopeShape {
  versionId: string;
  composition: Timeline;
  updatedAt: string;
}

// Kept as the name every existing caller (composition.service.ts,
// composition.controller.ts, the frontend) already imports.
export const compositionSchema = timelineSchema;
export type Composition = Timeline;

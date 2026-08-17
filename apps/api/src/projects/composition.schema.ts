import { z } from "zod";

// Matches the "Timeline composition JSON specification" in the product spec.
export const transformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
});

// Effect/transition params are added when that module is built — clip/audio/
// text placement is this increment's scope.
const timelineItemBase = {
  id: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  transform: transformSchema.default({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }),
};

const mediaItemFields = {
  mediaAssetId: z.string().min(1),
  trimInMs: z.number().int().nonnegative().default(0),
  trimOutMs: z.number().int().nonnegative().default(0),
};

const clipItemSchema = z.object({ ...timelineItemBase, type: z.literal("clip"), ...mediaItemFields });
const audioItemSchema = z.object({ ...timelineItemBase, type: z.literal("audio"), ...mediaItemFields });

// Text items aren't backed by a MediaAsset — content/style live on the item
// itself. Rotation is deliberately not part of the style: the renderer's
// drawtext filter has no rotation option, so supporting it in the editor
// would mean the preview and the actual export could disagree — see the
// README's "Text overlays" section.
const textItemSchema = z.object({
  ...timelineItemBase,
  type: z.literal("text"),
  content: z.string().min(1).max(500),
  fontSize: z.number().int().min(8).max(300).default(48),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "color must be a #rrggbb hex value")
    .default("#ffffff"),
});

export const timelineItemSchema = z.discriminatedUnion("type", [clipItemSchema, audioItemSchema, textItemSchema]);

export const trackSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["video", "audio", "text", "overlay"]),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  items: z.array(timelineItemSchema).default([]),
});

export const sceneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  durationMs: z.number().int().positive(),
  tracks: z.array(trackSchema).default([]),
});

export const compositionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  aspectRatio: z.string().min(1),
  fps: z.number().int().positive(),
  scenes: z.array(sceneSchema),
  updatedAt: z.string(),
});

export type Composition = z.infer<typeof compositionSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Track = z.infer<typeof trackSchema>;
export type TimelineItem = z.infer<typeof timelineItemSchema>;
export type Transform = z.infer<typeof transformSchema>;

import { z } from "zod";

// Matches the "Timeline composition JSON specification" in the product spec.
export const transformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
});

// Text/title items and effect/transition params are added when the modules
// that own them (text overlays, transitions) are built — clip/audio placement
// is this increment's scope.
export const timelineItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["clip", "audio"]),
  mediaAssetId: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  trimInMs: z.number().int().nonnegative().default(0),
  trimOutMs: z.number().int().nonnegative().default(0),
  transform: transformSchema.default({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }),
});

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

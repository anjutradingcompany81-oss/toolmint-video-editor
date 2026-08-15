import { z } from "zod";

// Matches the "Timeline composition JSON specification" in the product spec.
// Tracks/items are validated loosely for now — the Timeline module (next)
// tightens item/keyframe/effect shapes without needing a schema migration,
// since scenes already carry an (empty, for now) tracks array.
export const trackSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["video", "audio", "text", "overlay"]),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  items: z.array(z.unknown()).default([]),
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

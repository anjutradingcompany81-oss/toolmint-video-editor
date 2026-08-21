import { z } from "zod";

// ProCut's whole editing model: one project = one ordered list of clips.
// No scenes, no tracks, no transitions-as-objects, no text overlays — the
// merge is always a straight concat of clips in array order, and array
// order *is* the timeline order (no separate startMs to keep in sync).
export const clipSchema = z.object({
  id: z.string().min(1),
  mediaAssetId: z.string().min(1),
  // Offsets into the *source* file — trimOutMs counts back from the
  // source's own end, not from durationMs, so trimIn/trimOut stay valid
  // reference points regardless of how a split later divides this range.
  trimInMs: z.number().int().nonnegative().default(0),
  trimOutMs: z.number().int().nonnegative().default(0),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().default(false),
});

export const timelineSchema = z.object({
  schemaVersion: z.literal("1.0"),
  clips: z.array(clipSchema).default([]),
  updatedAt: z.string(),
});

export type Clip = z.infer<typeof clipSchema>;
export type Timeline = z.infer<typeof timelineSchema>;

// Kept as the exported name every existing caller (composition.service.ts,
// composition.controller.ts) already imports — renaming those too would
// touch the route/persistence layer for no reason, since it stays
// generically "whatever JSON blob is currently valid" either way.
export const compositionSchema = timelineSchema;
export type Composition = Timeline;

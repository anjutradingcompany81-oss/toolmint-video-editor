import { apiFetch } from "./api-client";

// ProCut's whole editing model: one project = one ordered list of clips.
// No scenes, no tracks — the merge is always a straight concat of clips in
// array order, and array order *is* the timeline order.
export interface Clip {
  id: string;
  mediaAssetId: string;
  // Offsets into the *source* file — trimOutMs counts back from the
  // source's own end, so trimIn/trimOut stay valid regardless of how a
  // later split divides this range.
  trimInMs: number;
  trimOutMs: number;
  volume: number;
  muted: boolean;
}

export interface Timeline {
  schemaVersion: "1.0";
  clips: Clip[];
  updatedAt: string;
}

export interface TimelineEnvelope {
  versionId: string;
  composition: Timeline;
  updatedAt: string;
}

export function getComposition(projectId: string) {
  return apiFetch<TimelineEnvelope>(`/projects/${projectId}/composition`);
}

export function saveComposition(projectId: string, timeline: Timeline) {
  return apiFetch<TimelineEnvelope>(`/projects/${projectId}/composition`, {
    method: "POST",
    body: JSON.stringify(timeline),
  });
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newClip(mediaAssetId: string): Clip {
  return { id: randomId("clip"), mediaAssetId, trimInMs: 0, trimOutMs: 0, volume: 1, muted: false };
}

// A clip's own playable span after trimming, given the full source
// duration — clamped so a clip can never shrink to nothing.
export const MIN_CLIP_DURATION_MS = 200;

export function clipDurationMs(clip: Pick<Clip, "trimInMs" | "trimOutMs">, sourceDurationMs: number): number {
  return Math.max(MIN_CLIP_DURATION_MS, sourceDurationMs - clip.trimInMs - clip.trimOutMs);
}

// Splits one clip into two at `offsetMs` into its own playable span —
// used by the timeline's split-at-playhead action. Both halves reference
// the same source media; the cut point becomes the first half's trim-out
// and the second half's trim-in.
export function splitClip(clip: Clip, sourceDurationMs: number, offsetMs: number): [Clip, Clip] | null {
  const duration = clipDurationMs(clip, sourceDurationMs);
  if (offsetMs < MIN_CLIP_DURATION_MS || offsetMs > duration - MIN_CLIP_DURATION_MS) return null;

  const splitSourceMs = clip.trimInMs + offsetMs;
  const first: Clip = { ...clip, id: randomId("clip"), trimOutMs: sourceDurationMs - splitSourceMs };
  const second: Clip = { ...clip, id: randomId("clip"), trimInMs: splitSourceMs };
  return [first, second];
}

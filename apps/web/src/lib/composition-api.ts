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

export type RemoveRangeResult = { ok: true; clips: Clip[] } | { ok: false; message: string };

// "Cut unwanted middle portion": removes an absolute timeline range
// [startMs, endMs) from the whole clip array, splitting/trimming/dropping
// whichever clips it overlaps. Because ProCut's timeline has no absolute
// clip positions — array order alone *is* the timeline order — the result
// is automatically contiguous with no gap to close: this is what "ripple
// delete" means here, and it's the only delete behavior this data model
// can represent (a gap-leaving "standard delete" would need clips to carry
// their own absolute start time, which they deliberately don't).
//
// Each clip is handled independently by intersecting its own timeline span
// with the cut range and mapping that intersection back into *source* time
// (via its current trimIn/trimOut): a clip with no overlap is untouched, a
// clip fully inside the cut range is dropped, a clip overlapping only one
// edge is trimmed on that side, and a clip that fully contains the cut
// range is split in two — the exact "remove the unwanted middle of this
// one clip" case the feature is named for.
export function removeRange(clips: Clip[], sourceDurationOf: (clip: Clip) => number, startMs: number, endMs: number): RemoveRangeResult {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    return { ok: false, message: "Select a valid start and end point before cutting." };
  }

  const next: Clip[] = [];
  let cursor = 0;
  let touchedAnything = false;

  for (const clip of clips) {
    const sourceDurationMs = sourceDurationOf(clip);
    const durationMs = clipDurationMs(clip, sourceDurationMs);
    const clipStart = cursor;
    const clipEnd = cursor + durationMs;
    cursor = clipEnd;

    const overlapStart = Math.max(clipStart, startMs);
    const overlapEnd = Math.min(clipEnd, endMs);

    if (overlapStart >= overlapEnd) {
      next.push(clip);
      continue;
    }
    touchedAnything = true;

    const srcIn = clip.trimInMs;
    const srcOut = sourceDurationMs - clip.trimOutMs;
    const srcOverlapStart = srcIn + (overlapStart - clipStart);
    const srcOverlapEnd = srcIn + (overlapEnd - clipStart);

    const leftDurationMs = srcOverlapStart - srcIn;
    const rightDurationMs = srcOut - srcOverlapEnd;
    const keepsLeft = leftDurationMs >= MIN_CLIP_DURATION_MS;
    const keepsRight = rightDurationMs >= MIN_CLIP_DURATION_MS;

    if (keepsLeft && keepsRight) {
      // The cut range falls entirely inside this one clip — split it in
      // two, same as a manual split-at-playhead on each edge.
      next.push({ ...clip, id: randomId("clip"), trimOutMs: sourceDurationMs - srcOverlapStart });
      next.push({ ...clip, id: randomId("clip"), trimInMs: srcOverlapEnd });
    } else if (keepsLeft) {
      // Only trimming one edge — same clip, just shorter, so it keeps its
      // id (matches how drag-to-trim already behaves elsewhere).
      next.push({ ...clip, trimOutMs: sourceDurationMs - srcOverlapStart });
    } else if (keepsRight) {
      next.push({ ...clip, trimInMs: srcOverlapEnd });
    }
    // Neither side survives — the clip is fully consumed by the cut, drop it.
  }

  if (!touchedAnything) {
    return { ok: false, message: "The selected range doesn't overlap any clip on the timeline." };
  }

  return { ok: true, clips: next };
}

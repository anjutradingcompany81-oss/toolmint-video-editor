import { apiFetch } from "./api-client";

// v2 timeline: multiple tracks, each holding clips with an *absolute*
// timeline position (startMs) — mirrors apps/api/src/projects/composition.schema.ts
// exactly. "Music" vs "Voice-over", or "Titles" vs "Captions", are
// deliberately not separate track kinds — just audio-kind (or text-kind)
// tracks with a different user-given name.
export type TrackKind = "video" | "audio" | "text" | "overlay";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  order: number;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  solo: boolean;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

interface BaseClip {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
}

// AI Repetitive Voice Remover, "audio-only correction": a sub-range of
// this clip's own audio (clip-local coordinates, [0, durationMs)) that
// plays room tone instead of the real source audio — used when removing
// a duplicated line while preserving the video's duration. See
// apps/api/src/render/merge-ffmpeg.util.ts for how this is rendered.
export interface AudioPatch {
  id: string;
  startMs: number;
  endMs: number;
  roomToneSourceStartMs?: number;
  roomToneSourceEndMs?: number;
  repetitionResultId?: string;
}

export interface MediaClip extends BaseClip {
  kind: "video" | "audio" | "overlay";
  mediaAssetId: string;
  trimInMs: number;
  trimOutMs: number;
  volume: number;
  muted: boolean;
  speedPercent: number;
  transform: Transform;
  audioPatches: AudioPatch[];
}

export interface TextClip extends BaseClip {
  kind: "text";
  content: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  transform: Transform;
}

export type Clip = MediaClip | TextClip;

// One caption line, in timeline-absolute ms — the same coordinate space the
// preview and renderer already use. Mirrors composition.schema.ts.
export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleStyle {
  fontSizePx: number;
  colorHex: string;
  outlineHex: string;
  position: "BOTTOM" | "TOP";
  /** Off by default: SRT/VTT can be exported without altering the picture. */
  burnIn: boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSizePx: 24,
  colorHex: "#FFFFFF",
  outlineHex: "#000000",
  position: "BOTTOM",
  burnIn: false,
};

export interface Timeline {
  schemaVersion: "2.0";
  tracks: Track[];
  clips: Clip[];
  subtitles: SubtitleCue[];
  subtitleStyle: SubtitleStyle;
  updatedAt: string;
}

export function newSubtitleCue(startMs: number, endMs: number, text: string): SubtitleCue {
  return { id: randomId("cue"), startMs, endMs, text };
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

export const MIN_CLIP_DURATION_MS = 200;

export function clipDurationFromTrim(sourceDurationMs: number, trimInMs: number, trimOutMs: number): number {
  return Math.max(MIN_CLIP_DURATION_MS, sourceDurationMs - trimInMs - trimOutMs);
}

export function newVideoClip(trackId: string, mediaAssetId: string, startMs: number, sourceDurationMs: number): MediaClip {
  return {
    id: randomId("clip"),
    trackId,
    kind: "video",
    mediaAssetId,
    startMs,
    durationMs: clipDurationFromTrim(sourceDurationMs, 0, 0),
    trimInMs: 0,
    trimOutMs: 0,
    volume: 1,
    muted: false,
    speedPercent: 100,
    transform: { ...DEFAULT_TRANSFORM },
    audioPatches: [],
  };
}

// Too thin a sliver of a patch to matter (leftover after clamping to a new
// clip window during a trim/split) isn't worth keeping — the tiny gap it
// would leave just plays real source audio instead, which is harmless.
const MIN_PATCH_DURATION_MS = 50;

// Remaps audioPatches from a clip's *old* local coordinate space into a
// *new* one that only spans [windowStartMs, windowEndMs) of the old space
// (windowStartMs becomes the new 0) — used whenever a clip carrying
// patches gets trimmed or split, so a correction never silently points at
// the wrong slice of the (possibly now-shorter, possibly repositioned)
// clip. A patch that falls entirely outside the kept window is dropped;
// one that straddles the boundary is clamped to it.
function remapAudioPatches(patches: AudioPatch[], windowStartMs: number, windowEndMs: number): AudioPatch[] {
  const result: AudioPatch[] = [];
  for (const patch of patches) {
    const clampedStart = Math.max(patch.startMs, windowStartMs);
    const clampedEnd = Math.min(patch.endMs, windowEndMs);
    if (clampedEnd - clampedStart < MIN_PATCH_DURATION_MS) continue;
    result.push({ ...patch, startMs: clampedStart - windowStartMs, endMs: clampedEnd - windowStartMs });
  }
  return result;
}

export interface ResolvedSourceRange {
  clip: MediaClip;
  /** Clip-local ms, i.e. the coordinate space audioPatches use. */
  localStartMs: number;
  localEndMs: number;
  /** Absolute timeline ms, for seeking and for a whole-range cut. */
  timelineStartMs: number;
  timelineEndMs: number;
}

// Finds where a range of the ORIGINAL media file currently sits on the
// timeline. AI corrections are discovered against the source audio, but the
// clip carrying that audio can afterwards be trimmed, split (which mints
// brand-new clip ids), moved, duplicated or reordered — so a correction
// recorded as "clipId X, timeline 2:26" is stale the moment the user edits,
// while "source offset 146,480ms of asset Y" stays true forever.
//
// Picks the clip with the largest overlap, since a split can leave the
// requested range straddling two clips; the correction is then applied to
// whichever half actually contains most of it, clamped to that clip.
export function resolveSourceRange(clips: Clip[], mediaAssetId: string, sourceStartMs: number, sourceEndMs: number): ResolvedSourceRange | null {
  let best: ResolvedSourceRange | null = null;
  let bestOverlap = 0;

  for (const clip of clips) {
    if (clip.kind === "text" || clip.mediaAssetId !== mediaAssetId) continue;
    const clipSourceStart = clip.trimInMs;
    const clipSourceEnd = clip.trimInMs + clip.durationMs;
    const overlapStart = Math.max(sourceStartMs, clipSourceStart);
    const overlapEnd = Math.min(sourceEndMs, clipSourceEnd);
    const overlap = overlapEnd - overlapStart;
    if (overlap <= bestOverlap) continue;

    bestOverlap = overlap;
    const localStartMs = overlapStart - clipSourceStart;
    const localEndMs = overlapEnd - clipSourceStart;
    best = {
      clip,
      localStartMs,
      localEndMs,
      timelineStartMs: clip.startMs + localStartMs,
      timelineEndMs: clip.startMs + localEndMs,
    };
  }

  return bestOverlap >= MIN_PATCH_DURATION_MS ? best : null;
}

export type AddPatchResult = { ok: true; clips: Clip[] } | { ok: false; message: string };

// Adds one room-tone patch to a specific clip (AI Repetitive Voice
// Remover's "audio-only correction" / "Replace with Room Tone").
//
// This used to assume the caller's range was always valid, "since it comes
// from a fresh scan result". That assumption breaks the moment the user
// edits the timeline after scanning: a result's coordinates are captured
// at scan time, so once a clip has been trimmed, split or moved they can
// land past the clip's end or on top of an existing patch. The composition
// schema rejects both, so the write turned into a silent 400 — and because
// the bad patch stayed in local state, *every later autosave failed too*,
// surfacing only as a permanent "Couldn't save" with no indication of why.
// It now validates and reports instead, so a stale correction fails loudly
// and by itself.
export function addAudioPatch(clips: Clip[], clipId: string, patch: Omit<AudioPatch, "id">): AddPatchResult {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || clip.kind === "text") return { ok: false, message: "That clip is no longer on the timeline." };

  const startMs = Math.max(0, Math.round(patch.startMs));
  const endMs = Math.min(clip.durationMs, Math.round(patch.endMs));
  if (endMs - startMs < MIN_PATCH_DURATION_MS) {
    return {
      ok: false,
      message: "This correction points at part of the clip that no longer exists — the timeline changed after the scan. Run a new scan and try again.",
    };
  }
  if (clip.audioPatches.some((p) => startMs < p.endMs && endMs > p.startMs)) {
    return { ok: false, message: "That part of the clip has already been corrected." };
  }

  const next = [...clip.audioPatches, { ...patch, startMs, endMs, id: randomId("patch") }].sort((a, b) => a.startMs - b.startMs);
  return { ok: true, clips: clips.map((c) => (c.id === clipId && c.kind !== "text" ? { ...c, audioPatches: next } : c)) };
}

// Removes a previously-applied patch (AI Repetitive Voice Remover's
// "Undo Correction" / "Reset to Original Audio" for one result) — the
// clip's real source audio plays there again, unchanged, since the patch
// never touched it.
export function removeAudioPatch(clips: Clip[], clipId: string, patchId: string): Clip[] {
  return clips.map((c) => (c.id === clipId && c.kind !== "text" ? { ...c, audioPatches: c.audioPatches.filter((p) => p.id !== patchId) } : c));
}

// Finds the nearest valid startMs for a clip of `durationMs` that avoids
// overlapping any `others` (every other clip already on the same track),
// starting from `candidateMs` — free timeline placement allows gaps
// between clips but never an overlap on the same track, mirroring
// composition.schema.ts's per-track validation. Clamping live during a
// drag (rather than only at save time) means every frame of the drag is
// already a save-valid position, so there's never a moment where letting
// go produces a validation error the user didn't see coming.
export function clampMoveStartMs(others: { startMs: number; durationMs: number }[], durationMs: number, candidateMs: number): number {
  const candidate = Math.max(0, candidateMs);
  const sorted = [...others].sort((a, b) => a.startMs - b.startMs);

  const gaps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const o of sorted) {
    if (o.startMs > cursor) gaps.push({ start: cursor, end: o.startMs });
    cursor = Math.max(cursor, o.startMs + o.durationMs);
  }
  gaps.push({ start: cursor, end: Infinity });

  // Already fits somewhere without moving further? Use it as-is.
  for (const gap of gaps) {
    if (candidate >= gap.start && candidate + durationMs <= gap.end) return candidate;
  }

  // Otherwise snap to whichever edge of the nearest large-enough gap is
  // closest to the raw drop point (the trailing [cursor, Infinity) gap
  // always qualifies, so this always finds a valid position).
  let best = 0;
  let bestDist = Infinity;
  for (const gap of gaps) {
    if (gap.end - gap.start < durationMs) continue;
    const maxStartInGap = gap.end === Infinity ? Infinity : gap.end - durationMs;
    const target = Math.min(Math.max(candidate, gap.start), maxStartInGap);
    const dist = Math.abs(target - candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best;
}

// Moves one clip to a new absolute timeline position, clamped to avoid
// overlapping any other clip on the *same* track (different tracks never
// collide with each other). Unlike repackTrack, this deliberately leaves
// whatever gap the move creates in place — free placement is the point.
export function moveClip(clips: Clip[], clipId: string, candidateStartMs: number): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const others = clips.filter((c) => c.trackId === clip.trackId && c.id !== clipId).map((c) => ({ startMs: c.startMs, durationMs: c.durationMs }));
  const startMs = clampMoveStartMs(others, clip.durationMs, candidateStartMs);
  return clips.map((c) => (c.id === clipId ? { ...c, startMs } : c));
}

// Applies new trim offsets to one clip and — critically — recomputes the
// timeline geometry that follows from them. The previous implementation
// only wrote trimInMs/trimOutMs and left durationMs untouched, so trimming
// visibly did nothing: the block kept its old width, the playhead math kept
// its old length, and the renderer emitted `trim=start=<trimIn>:duration=
// <stale durationMs>`, reading past the end of the source.
//
// Edge semantics match every mainstream editor: dragging the START handle
// moves the clip's left edge along the timeline (its right edge stays put),
// dragging the END handle only shortens it. Both are clamped against the
// neighbours on the same track so a trim can never create the overlap the
// backend schema rejects.
export function trimClipOnTrack(
  clips: Clip[],
  clipId: string,
  sourceDurationMs: number,
  requestedTrimInMs: number,
  requestedTrimOutMs: number,
): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip || clip.kind === "text" || sourceDurationMs <= 0) return clips;

  let trimInMs = Math.max(0, Math.round(requestedTrimInMs));
  let trimOutMs = Math.max(0, Math.round(requestedTrimOutMs));
  // Never let the two trims eat more than the source has to give.
  if (sourceDurationMs - trimInMs - trimOutMs < MIN_CLIP_DURATION_MS) {
    trimOutMs = Math.max(0, sourceDurationMs - trimInMs - MIN_CLIP_DURATION_MS);
    trimInMs = Math.min(trimInMs, Math.max(0, sourceDurationMs - trimOutMs - MIN_CLIP_DURATION_MS));
  }

  const others = clips.filter((c) => c.trackId === clip.trackId && c.id !== clipId);
  const clipEndMs = clip.startMs + clip.durationMs;
  const prevEndMs = others.reduce((max, o) => (o.startMs + o.durationMs <= clip.startMs ? Math.max(max, o.startMs + o.durationMs) : max), 0);
  const nextStartMs = others.reduce((min, o) => (o.startMs >= clipEndMs ? Math.min(min, o.startMs) : min), Number.POSITIVE_INFINITY);

  // Start edge: shifting trimIn by N shifts the clip's timeline start by N.
  let startMs = clip.startMs + (trimInMs - clip.trimInMs);
  const floorMs = Math.max(0, prevEndMs);
  if (startMs < floorMs) {
    // Can't extend left into the previous clip (or before zero) — give back
    // exactly as much trim as the available room allows.
    trimInMs += floorMs - startMs;
    startMs = floorMs;
  }

  let durationMs = Math.max(MIN_CLIP_DURATION_MS, sourceDurationMs - trimInMs - trimOutMs);
  if (startMs + durationMs > nextStartMs) {
    durationMs = Math.max(MIN_CLIP_DURATION_MS, nextStartMs - startMs);
    trimOutMs = Math.max(0, sourceDurationMs - trimInMs - durationMs);
  }

  // Patches live in clip-local coordinates, so a trim that moves local zero
  // has to move them with it or a correction silently drifts onto the wrong
  // words. The kept window, expressed in the clip's OLD local space:
  const windowStartMs = trimInMs - clip.trimInMs;
  return clips.map((c) =>
    c.id === clipId && c.kind !== "text"
      ? { ...c, trimInMs, trimOutMs, startMs, durationMs, audioPatches: remapAudioPatches(c.audioPatches, windowStartMs, windowStartMs + durationMs) }
      : c,
  );
}

// Closes the gap left behind after removing `removedClipId`, by pulling
// every later clip on that track back by exactly the removed clip's span —
// the "ripple delete" every editor offers alongside a plain delete. Kept
// distinct from repackTrack, which flattens *all* spacing on the track:
// rippling one deletion must not also silently swallow gaps the user
// deliberately created elsewhere.
export function rippleDeleteClip(clips: Clip[], clipId: string): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const removedEndMs = clip.startMs + clip.durationMs;
  return clips
    .filter((c) => c.id !== clipId)
    .map((c) => (c.trackId === clip.trackId && c.startMs >= removedEndMs ? { ...c, startMs: Math.max(0, c.startMs - clip.durationMs) } : c));
}

// Places a copy of `clipId` in the first gap large enough to hold it at or
// after the original's end, so duplicating never overlaps and never
// silently lands somewhere the user can't see.
export function duplicateClip(clips: Clip[], clipId: string): Clip[] {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return clips;
  const others = clips.filter((c) => c.trackId === clip.trackId).map((c) => ({ startMs: c.startMs, durationMs: c.durationMs }));
  const startMs = clampMoveStartMs(others, clip.durationMs, clip.startMs + clip.durationMs);
  const copy: Clip =
    clip.kind === "text"
      ? { ...clip, id: randomId("clip"), startMs }
      : { ...clip, id: randomId("clip"), startMs, audioPatches: clip.audioPatches.map((p) => ({ ...p, id: randomId("patch") })) };
  return [...clips, copy];
}

export function newVideoTrack(name: string, order: number): Track {
  return { id: randomId("track"), kind: "video", name, order, locked: false, hidden: false, muted: false, solo: false };
}

// The generated AI voice over lands on its own audio track rather than
// being mixed into the source clips: the source stays untouched (this is a
// non-destructive editor), the user can mute or delete the narration in
// one action, and regenerating just replaces this track's contents.
export function newAudioTrack(name: string, order: number): Track {
  return { id: randomId("track"), kind: "audio", name, order, locked: false, hidden: false, muted: false, solo: false };
}

// An audio clip is a media clip with no picture — the renderer already
// mixes any "audio"-kind clip through the same amix path as a video
// clip's embedded audio, so nothing downstream needs a new case for it.
export function newAudioClip(trackId: string, mediaAssetId: string, startMs: number, durationMs: number): MediaClip {
  return {
    id: randomId("clip"),
    trackId,
    kind: "audio",
    mediaAssetId,
    startMs,
    durationMs,
    trimInMs: 0,
    trimOutMs: 0,
    volume: 1,
    muted: false,
    speedPercent: 100,
    transform: { ...DEFAULT_TRANSFORM },
    audioPatches: [],
  };
}

// Overlay tracks composite above video (higher `order` renders on top —
// see merge-ffmpeg.util.ts's overlay chain), which is what a logo or
// watermark needs.
export function newOverlayTrack(name: string, order: number): Track {
  return { id: randomId("track"), kind: "overlay", name, order, locked: false, hidden: false, muted: false, solo: false };
}

export type LogoCorner = "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | "CUSTOM";

// Pixel offset of a logo from the canvas edges, given the canvas and the
// logo's own rendered size. The renderer's overlay filter takes absolute
// x/y in canvas pixels, so a corner preset has to be resolved against the
// actual dimensions rather than stored as a keyword.
export function logoPosition(
  corner: LogoCorner,
  canvas: { width: number; height: number },
  logo: { width: number; height: number },
  marginPx: number,
): { x: number; y: number } {
  const maxX = Math.max(0, canvas.width - logo.width);
  const maxY = Math.max(0, canvas.height - logo.height);
  switch (corner) {
    case "TOP_LEFT":
      return { x: marginPx, y: marginPx };
    case "TOP_RIGHT":
      return { x: maxX - marginPx, y: marginPx };
    case "BOTTOM_LEFT":
      return { x: marginPx, y: maxY - marginPx };
    case "BOTTOM_RIGHT":
      return { x: maxX - marginPx, y: maxY - marginPx };
    default:
      return { x: marginPx, y: marginPx };
  }
}

// A logo/watermark: an overlay-kind clip spanning a stretch of the
// timeline. Images have no intrinsic duration, so the caller supplies how
// long it should stay on screen (normally the whole project).
export function newLogoClip(
  trackId: string,
  mediaAssetId: string,
  startMs: number,
  durationMs: number,
  transform: Partial<Transform> = {},
): MediaClip {
  return {
    id: randomId("clip"),
    trackId,
    kind: "overlay",
    mediaAssetId,
    startMs,
    durationMs: Math.max(MIN_CLIP_DURATION_MS, durationMs),
    trimInMs: 0,
    trimOutMs: 0,
    // An overlay contributes no sound; muting it keeps the audio mix from
    // gaining a silent input for no reason.
    volume: 0,
    muted: true,
    speedPercent: 100,
    transform: { ...DEFAULT_TRANSFORM, ...transform },
    audioPatches: [],
  };
}

// Re-packs every clip on one track so they sit back-to-back with no gaps,
// in ascending order of their *current* startMs — array order alone is no
// longer authoritative once clips carry absolute positions, so ordering
// has to be read from startMs and gaps have to be closed explicitly after
// every mutation (add/trim/split/reorder/remove) instead of falling out
// for free the way a flat position-less array gave it for free before.
export function repackTrack(clips: Clip[], trackId: string): Clip[] {
  const onTrack = [...clips].filter((c) => c.trackId === trackId).sort((a, b) => a.startMs - b.startMs);
  const repositioned = new Map<string, number>();
  let cursor = 0;
  for (const clip of onTrack) {
    repositioned.set(clip.id, cursor);
    cursor += clip.durationMs;
  }
  return clips.map((c) => (repositioned.has(c.id) ? { ...c, startMs: repositioned.get(c.id)! } : c));
}

// Splits one media clip into two at `offsetMs` into its own timeline
// duration. Both halves reference the same source media and stay on the
// same track, back-to-back — no repack needed since the split doesn't
// change the track's total span.
export function splitClip(clip: MediaClip, sourceDurationMs: number, offsetMs: number): [MediaClip, MediaClip] | null {
  if (offsetMs < MIN_CLIP_DURATION_MS || offsetMs > clip.durationMs - MIN_CLIP_DURATION_MS) return null;

  const splitSourceMs = clip.trimInMs + offsetMs;
  const first: MediaClip = {
    ...clip,
    id: randomId("clip"),
    durationMs: offsetMs,
    trimOutMs: sourceDurationMs - splitSourceMs,
    audioPatches: remapAudioPatches(clip.audioPatches, 0, offsetMs),
  };
  const second: MediaClip = {
    ...clip,
    id: randomId("clip"),
    startMs: clip.startMs + offsetMs,
    durationMs: clip.durationMs - offsetMs,
    trimInMs: splitSourceMs,
    audioPatches: remapAudioPatches(clip.audioPatches, offsetMs, clip.durationMs),
  };
  return [first, second];
}

export type RemoveRangeResult = { ok: true; clips: Clip[] } | { ok: false; message: string };

// "Cut unwanted middle portion": removes an absolute range [startMs, endMs)
// from one track, splitting/trimming/dropping whichever clips on that
// track it overlaps, then re-packs the track so the remainder joins with
// no gap — this is the only delete this timeline can represent, since
// clips have no notion of a "gap" to leave behind.
export function removeRangeOnTrack(
  clips: Clip[],
  trackId: string,
  sourceDurationOf: (clip: MediaClip) => number,
  startMs: number,
  endMs: number,
): RemoveRangeResult {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
    return { ok: false, message: "Select a valid start and end point before cutting." };
  }

  let touchedAnything = false;
  const next: Clip[] = [];

  for (const clip of clips) {
    if (clip.trackId !== trackId || clip.kind === "text") {
      next.push(clip);
      continue;
    }

    const clipStart = clip.startMs;
    const clipEnd = clip.startMs + clip.durationMs;
    const overlapStart = Math.max(clipStart, startMs);
    const overlapEnd = Math.min(clipEnd, endMs);

    if (overlapStart >= overlapEnd) {
      next.push(clip);
      continue;
    }
    touchedAnything = true;

    const sourceDurationMs = sourceDurationOf(clip);
    const srcIn = clip.trimInMs;
    const srcOut = sourceDurationMs - clip.trimOutMs;
    const srcOverlapStart = srcIn + (overlapStart - clipStart);
    const srcOverlapEnd = srcIn + (overlapEnd - clipStart);

    const leftDurationMs = srcOverlapStart - srcIn;
    const rightDurationMs = srcOut - srcOverlapEnd;
    const keepsLeft = leftDurationMs >= MIN_CLIP_DURATION_MS;
    const keepsRight = rightDurationMs >= MIN_CLIP_DURATION_MS;

    const localCutStart = overlapStart - clipStart;
    const localCutEnd = overlapEnd - clipStart;

    if (keepsLeft && keepsRight) {
      // The cut falls entirely inside this clip — split it in two.
      next.push({
        ...clip,
        id: randomId("clip"),
        durationMs: leftDurationMs,
        trimOutMs: sourceDurationMs - srcOverlapStart,
        audioPatches: remapAudioPatches(clip.audioPatches, 0, localCutStart),
      });
      next.push({
        ...clip,
        id: randomId("clip"),
        startMs: clip.startMs + localCutEnd,
        durationMs: rightDurationMs,
        trimInMs: srcOverlapEnd,
        audioPatches: remapAudioPatches(clip.audioPatches, localCutEnd, clip.durationMs),
      });
    } else if (keepsLeft) {
      next.push({
        ...clip,
        durationMs: leftDurationMs,
        trimOutMs: sourceDurationMs - srcOverlapStart,
        audioPatches: remapAudioPatches(clip.audioPatches, 0, localCutStart),
      });
    } else if (keepsRight) {
      next.push({
        ...clip,
        startMs: clip.startMs + localCutEnd,
        durationMs: rightDurationMs,
        trimInMs: srcOverlapEnd,
        audioPatches: remapAudioPatches(clip.audioPatches, localCutEnd, clip.durationMs),
      });
    }
    // Neither side survives — fully consumed by the cut, drop it.
  }

  if (!touchedAnything) {
    return { ok: false, message: "The selected range doesn't overlap any clip on the timeline." };
  }

  return { ok: true, clips: repackTrack(next, trackId) };
}

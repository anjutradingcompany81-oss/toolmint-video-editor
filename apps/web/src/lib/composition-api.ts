import { apiFetch } from "./api-client";

export type TrackType = "video" | "audio" | "text" | "overlay";
export type TimelineItemType = "clip" | "audio" | "text";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export type TransitionType = "fade" | "wipeleft" | "wiperight" | "slideup";

export const TRANSITION_TYPE_LABELS: Record<TransitionType, string> = {
  fade: "Fade",
  wipeleft: "Wipe left",
  wiperight: "Wipe right",
  slideup: "Slide up",
};

export interface MediaTimelineItem {
  id: string;
  type: "clip" | "audio";
  mediaAssetId: string;
  startMs: number;
  durationMs: number;
  trimInMs: number;
  trimOutMs: number;
  // Meaningful only when this item's startMs overlaps the previous item's
  // end on the same track — the overlap amount *is* the transition duration
  // (no separate field for it); this only picks the style. See the
  // README's "Transitions" section.
  transitionIn: TransitionType;
  transform: Transform;
  // 100 = normal speed. durationMs always stays the timeline footprint;
  // the amount of source consumed is durationMs * speedPercent/100.
  speedPercent: number;
}

// No mediaAssetId — content/style live on the item itself. Rotation is
// deliberately not editable for text: the render pipeline's drawtext filter
// has no rotation option, so the preview and the export would disagree.
export interface TextTimelineItem {
  id: string;
  type: "text";
  content: string;
  fontSize: number;
  color: string;
  startMs: number;
  durationMs: number;
  transform: Transform;
}

export type TimelineItem = MediaTimelineItem | TextTimelineItem;

export interface Track {
  id: string;
  type: TrackType;
  locked: boolean;
  muted: boolean;
  items: TimelineItem[];
}

export interface Scene {
  id: string;
  name: string;
  durationMs: number;
  tracks: Track[];
}

export interface Composition {
  schemaVersion: "1.0";
  aspectRatio: string;
  fps: number;
  scenes: Scene[];
  updatedAt: string;
}

export interface CompositionEnvelope {
  versionId: string;
  composition: Composition;
  updatedAt: string;
}

export function getComposition(projectId: string) {
  return apiFetch<CompositionEnvelope>(`/projects/${projectId}/composition`);
}

export function saveComposition(projectId: string, composition: Composition) {
  return apiFetch<CompositionEnvelope>(`/projects/${projectId}/composition`, {
    method: "POST",
    body: JSON.stringify(composition),
  });
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function newScene(order: number): Scene {
  return { id: randomId("scn"), name: `Scene ${order + 1}`, durationMs: 5000, tracks: [] };
}

export function newTrack(type: TrackType): Track {
  return { id: randomId("trk"), type, locked: false, muted: false, items: [] };
}

export function defaultTransform(): Transform {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
}

export function newTimelineItem(mediaAssetId: string, type: "clip" | "audio", startMs: number, durationMs: number): MediaTimelineItem {
  return {
    id: randomId("itm"),
    type,
    mediaAssetId,
    startMs,
    durationMs,
    trimInMs: 0,
    trimOutMs: 0,
    transitionIn: "fade",
    transform: defaultTransform(),
    speedPercent: 100,
  };
}

export const DEFAULT_TEXT_CONTENT = "Text";
export const DEFAULT_TEXT_DURATION_MS = 3000;

export function newTextItem(startMs: number): TextTimelineItem {
  return {
    id: randomId("itm"),
    type: "text",
    content: DEFAULT_TEXT_CONTENT,
    fontSize: 48,
    color: "#ffffff",
    startMs,
    durationMs: DEFAULT_TEXT_DURATION_MS,
    transform: defaultTransform(),
  };
}

// A track only accepts media of a compatible kind — matches typical NLE
// behavior and keeps "what can I drop here" unambiguous without a mixed-kind UI.
export function trackAcceptsMediaKind(trackType: TrackType, mediaKind: string): boolean {
  if (trackType === "video") return mediaKind === "VIDEO" || mediaKind === "IMAGE";
  if (trackType === "audio") return mediaKind === "AUDIO";
  return false;
}

export function defaultClipDurationMs(mediaKind: string): number {
  return mediaKind === "IMAGE" ? 3000 : 5000;
}

// Mirrors the backend's overlapWithPrevious (render.processor.ts) — the
// transition duration is never stored explicitly, it's derived from how far
// an item's startMs reaches back into its predecessor's tail on the same
// track. `items` must already be sorted by startMs.
export function overlapWithPreviousMs(items: { startMs: number; durationMs: number }[], index: number): number {
  if (index <= 0) return 0;
  const prev = items[index - 1];
  return Math.max(0, prev.startMs + prev.durationMs - items[index].startMs);
}

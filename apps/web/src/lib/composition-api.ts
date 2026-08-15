import { apiFetch } from "./api-client";

export type TrackType = "video" | "audio" | "text" | "overlay";
export type TimelineItemType = "clip" | "audio";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  mediaAssetId: string;
  startMs: number;
  durationMs: number;
  trimInMs: number;
  trimOutMs: number;
  transform: Transform;
}

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

export function newTimelineItem(mediaAssetId: string, type: TimelineItemType, startMs: number, durationMs: number): TimelineItem {
  return {
    id: randomId("itm"),
    type,
    mediaAssetId,
    startMs,
    durationMs,
    trimInMs: 0,
    trimOutMs: 0,
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

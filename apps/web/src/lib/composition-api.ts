import { apiFetch } from "./api-client";

export type TrackType = "video" | "audio" | "text" | "overlay";

export interface Track {
  id: string;
  type: TrackType;
  locked: boolean;
  muted: boolean;
  items: unknown[];
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

export function createSceneId(): string {
  return `scn_${Math.random().toString(36).slice(2, 10)}`;
}

export function newScene(order: number): Scene {
  return { id: createSceneId(), name: `Scene ${order + 1}`, durationMs: 5000, tracks: [] };
}

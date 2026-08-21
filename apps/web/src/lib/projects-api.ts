import { apiFetch } from "./api-client";

export interface Project {
  id: string;
  workspaceId: string;
  title: string;
  fps: number;
  thumbnailUrl: string | null;
  isArchived: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export type MediaKind = "VIDEO" | "IMAGE" | "AUDIO" | "DOCUMENT";
export type MediaStatus = "UPLOADING" | "PROCESSING" | "READY" | "FAILED";

export interface MediaAsset {
  id: string;
  projectId: string;
  kind: MediaKind;
  status: MediaStatus;
  originalName: string;
  storageKey: string;
  mimeType: string;
  byteSize: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  // Flat [min0, max0, min1, max1, ...] array, floats in -1..1, fixed at 200
  // buckets regardless of clip length — stretched to fit whatever pixel
  // width the clip occupies wherever it's drawn.
  waveformPeaks: number[] | null;
  createdAt: string;
  previewUrl: string | null;
}

export function listProjects(params: { includeArchived?: boolean; search?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.includeArchived) qs.set("includeArchived", "true");
  if (params.search) qs.set("search", params.search);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch<Project[]>(`/projects${suffix}`);
}

export function createProject(input: { title: string; fps?: number }) {
  return apiFetch<Project>("/projects", { method: "POST", body: JSON.stringify(input) });
}

export function getProject(id: string) {
  return apiFetch<Project>(`/projects/${id}`);
}

export function updateProject(id: string, input: { title?: string; isArchived?: boolean }) {
  return apiFetch<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function duplicateProject(id: string) {
  return apiFetch<Project>(`/projects/${id}/duplicate`, { method: "POST" });
}

export function deleteProject(id: string) {
  return apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
}

// Fed a real frame captured from the editor's own preview canvas — see
// scene-preview.tsx's captureFrame.
export function setProjectThumbnail(id: string, blob: Blob) {
  const formData = new FormData();
  formData.append("file", blob, "thumbnail.jpg");
  return apiFetch<Project>(`/projects/${id}/thumbnail`, { method: "POST", body: formData });
}

export function listMedia(projectId: string) {
  return apiFetch<MediaAsset[]>(`/projects/${projectId}/media`);
}

export function uploadMedia(projectId: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<MediaAsset>(`/projects/${projectId}/media`, { method: "POST", body: formData });
}

export function deleteMedia(projectId: string, mediaAssetId: string) {
  return apiFetch<void>(`/projects/${projectId}/media/${mediaAssetId}`, { method: "DELETE" });
}

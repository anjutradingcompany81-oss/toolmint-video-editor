import { apiFetch } from "./api-client";

export type AspectRatio = "RATIO_16_9" | "RATIO_9_16" | "RATIO_1_1" | "RATIO_4_5" | "RATIO_21_9" | "CUSTOM";

export const ASPECT_RATIO_LABELS: Record<AspectRatio, string> = {
  RATIO_16_9: "16:9 landscape",
  RATIO_9_16: "9:16 vertical",
  RATIO_1_1: "1:1 square",
  RATIO_4_5: "4:5 portrait",
  RATIO_21_9: "21:9 cinematic",
  CUSTOM: "Custom",
};

export interface Project {
  id: string;
  workspaceId: string;
  title: string;
  aspectRatio: AspectRatio;
  customWidth: number | null;
  customHeight: number | null;
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

export function createProject(input: { title: string; aspectRatio?: AspectRatio; fps?: number }) {
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

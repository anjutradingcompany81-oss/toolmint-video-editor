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

const LOCAL_PROJECTS_KEY = "procut_local_projects";
const localMediaStore = new Map<string, MediaAsset[]>();

function getLocalProjects(): Project[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(LOCAL_PROJECTS_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const defaultProj: Project = {
    id: "proj_default",
    workspaceId: "ws_default",
    title: "My Video Project",
    fps: 30,
    thumbnailUrl: null,
    isArchived: false,
    createdById: "direct_creator",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify([defaultProj]));
  return [defaultProj];
}

function saveLocalProjects(projects: Project[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
  }
}

export async function listProjects(params: { includeArchived?: boolean; search?: string } = {}): Promise<Project[]> {
  try {
    const qs = new URLSearchParams();
    if (params.includeArchived) qs.set("includeArchived", "true");
    if (params.search) qs.set("search", params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return await apiFetch<Project[]>(`/projects${suffix}`);
  } catch {
    let list = getLocalProjects();
    if (!params.includeArchived) list = list.filter((p) => !p.isArchived);
    if (params.search) {
      const q = params.search.toLowerCase();
      list = list.filter((p) => p.title.toLowerCase().includes(q));
    }
    return list;
  }
}

export async function createProject(input: { title: string; fps?: number }): Promise<Project> {
  try {
    return await apiFetch<Project>("/projects", { method: "POST", body: JSON.stringify(input) });
  } catch {
    const list = getLocalProjects();
    const newProj: Project = {
      id: "proj_" + Math.random().toString(36).slice(2, 9),
      workspaceId: "ws_default",
      title: input.title || "Untitled Project",
      fps: input.fps ?? 30,
      thumbnailUrl: null,
      isArchived: false,
      createdById: "direct_creator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    list.unshift(newProj);
    saveLocalProjects(list);
    return newProj;
  }
}

export async function getProject(id: string): Promise<Project> {
  try {
    return await apiFetch<Project>(`/projects/${id}`);
  } catch {
    const list = getLocalProjects();
    const found = list.find((p) => p.id === id);
    if (found) return found;
    const fallback: Project = {
      id,
      workspaceId: "ws_default",
      title: "My Video Project",
      fps: 30,
      thumbnailUrl: null,
      isArchived: false,
      createdById: "direct_creator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    list.push(fallback);
    saveLocalProjects(list);
    return fallback;
  }
}

export async function updateProject(id: string, input: { title?: string; isArchived?: boolean }): Promise<Project> {
  try {
    return await apiFetch<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  } catch {
    const list = getLocalProjects();
    const idx = list.findIndex((p) => p.id === id);
    if (idx !== -1) {
      list[idx] = { ...list[idx], ...input, updatedAt: new Date().toISOString() };
      saveLocalProjects(list);
      return list[idx];
    }
    throw new Error("Project not found");
  }
}

export async function duplicateProject(id: string): Promise<Project> {
  try {
    return await apiFetch<Project>(`/projects/${id}/duplicate`, { method: "POST" });
  } catch {
    const orig = await getProject(id);
    return createProject({ title: `${orig.title} (Copy)`, fps: orig.fps });
  }
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await apiFetch<void>(`/projects/${id}`, { method: "DELETE" });
  } catch {
    const list = getLocalProjects().filter((p) => p.id !== id);
    saveLocalProjects(list);
  }
}

export async function setProjectThumbnail(id: string, blob: Blob): Promise<Project> {
  try {
    const formData = new FormData();
    formData.append("file", blob, "thumbnail.jpg");
    return await apiFetch<Project>(`/projects/${id}/thumbnail`, { method: "POST", body: formData });
  } catch {
    return getProject(id);
  }
}

export async function listMedia(projectId: string): Promise<MediaAsset[]> {
  try {
    return await apiFetch<MediaAsset[]>(`/projects/${projectId}/media`);
  } catch {
    return localMediaStore.get(projectId) || [];
  }
}

async function probeMediaLocally(file: File): Promise<{
  kind: MediaKind;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  previewUrl: string;
}> {
  const mime = file.type.toLowerCase();
  const url = URL.createObjectURL(file);
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) {
    return new Promise((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      v.onloadedmetadata = () => {
        resolve({
          kind: "VIDEO",
          durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 5000,
          width: v.videoWidth || 1920,
          height: v.videoHeight || 1080,
          hasAudio: true,
          previewUrl: url,
        });
      };
      v.onerror = () => {
        resolve({ kind: "VIDEO", durationMs: 5000, width: 1920, height: 1080, hasAudio: true, previewUrl: url });
      };
    });
  } else if (mime.startsWith("audio/") || /\.(mp3|wav|aac|m4a|ogg)$/i.test(file.name)) {
    return new Promise((resolve) => {
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.src = url;
      a.onloadedmetadata = () => {
        resolve({
          kind: "AUDIO",
          durationMs: Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 5000,
          width: null,
          height: null,
          hasAudio: true,
          previewUrl: url,
        });
      };
      a.onerror = () => {
        resolve({ kind: "AUDIO", durationMs: 5000, width: null, height: null, hasAudio: true, previewUrl: url });
      };
    });
  } else if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = url;
      img.onload = () => {
        resolve({
          kind: "IMAGE",
          durationMs: null,
          width: img.naturalWidth || 500,
          height: img.naturalHeight || 500,
          hasAudio: false,
          previewUrl: url,
        });
      };
      img.onerror = () => {
        resolve({ kind: "IMAGE", durationMs: null, width: 500, height: 500, hasAudio: false, previewUrl: url });
      };
    });
  }
  return { kind: "VIDEO", durationMs: 5000, width: 1920, height: 1080, hasAudio: true, previewUrl: url };
}

export async function uploadMedia(projectId: string, file: File): Promise<MediaAsset> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    return await apiFetch<MediaAsset>(`/projects/${projectId}/media`, { method: "POST", body: formData });
  } catch {
    const probed = await probeMediaLocally(file);
    const asset: MediaAsset = {
      id: "asset_" + Math.random().toString(36).slice(2, 9),
      projectId,
      kind: probed.kind,
      status: "READY",
      originalName: file.name,
      storageKey: `local/${file.name}`,
      mimeType: file.type || "video/mp4",
      byteSize: file.size,
      durationMs: probed.durationMs,
      width: probed.width,
      height: probed.height,
      hasAudio: probed.hasAudio,
      waveformPeaks: null,
      createdAt: new Date().toISOString(),
      previewUrl: probed.previewUrl,
    };
    const list = localMediaStore.get(projectId) || [];
    list.push(asset);
    localMediaStore.set(projectId, list);
    return asset;
  }
}

export async function deleteMedia(projectId: string, mediaAssetId: string): Promise<void> {
  try {
    await apiFetch<void>(`/projects/${projectId}/media/${mediaAssetId}`, { method: "DELETE" });
  } catch {
    const list = (localMediaStore.get(projectId) || []).filter((m) => m.id !== mediaAssetId);
    localMediaStore.set(projectId, list);
  }
}

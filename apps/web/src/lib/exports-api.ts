import { apiFetch } from "./api-client";

export type ExportResolution = "R720P" | "R1080P";
export type ExportStatus = "QUEUED" | "PROCESSING" | "UPLOADING" | "COMPLETED" | "FAILED";

export interface ExportJob {
  id: string;
  projectId: string;
  sceneId: string;
  resolution: ExportResolution;
  status: ExportStatus;
  progress: number;
  errorMessage: string | null;
  outputStorageKey: string | null;
  outputByteSize: number | null;
  requestedById: string;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
}

export function createExport(projectId: string, sceneId: string, resolution: ExportResolution) {
  return apiFetch<ExportJob>(`/projects/${projectId}/exports`, {
    method: "POST",
    body: JSON.stringify({ sceneId, resolution }),
  });
}

export function listExports(projectId: string) {
  return apiFetch<ExportJob[]>(`/projects/${projectId}/exports`);
}

export const ACTIVE_EXPORT_STATUSES: ExportStatus[] = ["QUEUED", "PROCESSING", "UPLOADING"];

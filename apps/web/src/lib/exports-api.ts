import { apiFetch } from "./api-client";

export type ExportResolution = "R720P" | "R1080P" | "ORIGINAL";
export type ExportQuality = "STANDARD" | "HIGH" | "MAXIMUM";
export type ExportStatus = "QUEUED" | "PROCESSING" | "UPLOADING" | "COMPLETED" | "FAILED" | "CANCELLED";

export const RESOLUTION_LABELS: Record<ExportResolution, string> = {
  R720P: "720p",
  R1080P: "1080p",
  ORIGINAL: "Original",
};

export const QUALITY_LABELS: Record<ExportQuality, string> = {
  STANDARD: "Standard",
  HIGH: "High",
  MAXIMUM: "Maximum",
};

export interface ExportJob {
  id: string;
  projectId: string;
  resolution: ExportResolution;
  quality: ExportQuality;
  outputFileName: string | null;
  status: ExportStatus;
  progress: number;
  cancelRequested: boolean;
  errorMessage: string | null;
  outputStorageKey: string | null;
  outputByteSize: number | null;
  requestedById: string;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
}

export function createExport(projectId: string, input: { resolution: ExportResolution; quality: ExportQuality; outputFileName?: string }) {
  return apiFetch<ExportJob>(`/projects/${projectId}/exports`, { method: "POST", body: JSON.stringify(input) });
}

export function listExports(projectId: string) {
  return apiFetch<ExportJob[]>(`/projects/${projectId}/exports`);
}

export function getExport(projectId: string, jobId: string) {
  return apiFetch<ExportJob>(`/projects/${projectId}/exports/${jobId}`);
}

export function cancelExport(projectId: string, jobId: string) {
  return apiFetch<ExportJob>(`/projects/${projectId}/exports/${jobId}/cancel`, { method: "POST" });
}

export const ACTIVE_EXPORT_STATUSES: ExportStatus[] = ["QUEUED", "PROCESSING", "UPLOADING"];

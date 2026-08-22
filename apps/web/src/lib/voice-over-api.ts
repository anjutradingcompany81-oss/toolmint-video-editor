import { apiFetch } from "./api-client";

export type VoiceOverStatus = "QUEUED" | "SYNTHESIZING" | "MIXING" | "COMPLETED" | "FAILED" | "CANCELLED";

export const ACTIVE_VOICE_OVER_STATUSES: VoiceOverStatus[] = ["QUEUED", "SYNTHESIZING", "MIXING"];

/**
 * READY               - implemented and usable right now.
 * NEEDS_CONFIGURATION - implemented, but this server is missing its API key.
 *
 * The panel renders these verbatim rather than hiding unconfigured
 * providers, so a user can see that voice cloning exists and what it
 * would take to switch it on, instead of a control that silently isn't
 * there.
 */
export type TtsReadiness = "READY" | "NEEDS_CONFIGURATION";

export interface TtsVoice {
  id: string;
  label: string;
  language: string;
  gender?: "male" | "female" | "neutral";
}

export interface TtsProviderStatus {
  id: string;
  label: string;
  description: string;
  readiness: TtsReadiness;
  requiredEnvVar: string | null;
  supportsVoiceCloning: boolean;
  voices: TtsVoice[];
}

export interface VoiceOverLine {
  id: string;
  /** Timeline position where this line starts speaking. */
  startMs: number;
  text: string;
  voiceId: string;
  speakerLabel?: string;
}

/** Measured after synthesis - the length of a spoken line isn't knowable before generating it. */
export interface VoiceOverLineTiming {
  lineId: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  overlapsNextByMs: number;
}

export interface VoiceOverJob {
  id: string;
  projectId: string;
  status: VoiceOverStatus;
  stageLabel: string | null;
  progress: number;
  providerId: string;
  lines: VoiceOverLine[];
  lineTimings: VoiceOverLineTiming[] | null;
  resultMediaAssetId: string | null;
  cancelRequested: boolean;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface VoiceOverScript {
  providerId: string | null;
  lines: VoiceOverLine[];
  updatedAt: string | null;
}

export function getVoiceOverProviders(projectId: string) {
  return apiFetch<TtsProviderStatus[]>(`/projects/${projectId}/voice-over/providers`);
}

export function getVoiceOverScript(projectId: string) {
  return apiFetch<VoiceOverScript>(`/projects/${projectId}/voice-over/script`);
}

export function saveVoiceOverScript(projectId: string, input: { providerId?: string; lines: VoiceOverLine[] }) {
  return apiFetch<VoiceOverScript>(`/projects/${projectId}/voice-over/script`, { method: "PUT", body: JSON.stringify(input) });
}

export function generateVoiceOver(projectId: string, input: { providerId: string; lines: VoiceOverLine[] }) {
  return apiFetch<VoiceOverJob>(`/projects/${projectId}/voice-over/jobs`, { method: "POST", body: JSON.stringify(input) });
}

export function listVoiceOverJobs(projectId: string) {
  return apiFetch<VoiceOverJob[]>(`/projects/${projectId}/voice-over/jobs`);
}

export function getVoiceOverJob(projectId: string, jobId: string) {
  return apiFetch<VoiceOverJob>(`/projects/${projectId}/voice-over/jobs/${jobId}`);
}

export function cancelVoiceOverJob(projectId: string, jobId: string) {
  return apiFetch<VoiceOverJob>(`/projects/${projectId}/voice-over/jobs/${jobId}/cancel`, { method: "POST" });
}

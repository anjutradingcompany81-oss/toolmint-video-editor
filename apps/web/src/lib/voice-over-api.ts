import { API_BASE_URL, apiFetch, ApiError, getAccessToken } from "./api-client";

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

export interface ScriptGenStatus {
  ready: boolean;
  requiredEnvVar: string;
}

export function getScriptGenStatus(projectId: string) {
  return apiFetch<ScriptGenStatus>(`/projects/${projectId}/voice-over/script-gen-status`);
}

// Returns plain narration text, one entry per spoken line — no timing, no
// ids, no voiceId. The caller lays these onto the timeline itself (see
// script-line-layout.ts), the same way importFromTranscript builds
// VoiceOverLine[] from raw transcript data.
export function generateScriptFromPrompt(projectId: string, input: { prompt: string; targetDurationMs: number; language?: string }) {
  return apiFetch<{ lines: string[] }>(`/projects/${projectId}/voice-over/generate-script`, { method: "POST", body: JSON.stringify(input) });
}

// Returns playable audio bytes directly rather than JSON, so this can't
// go through apiFetch (which always parses the body as JSON) — built by
// hand the same way apiFetch attaches the token and reads an error body,
// just returning a Blob instead of a parsed object on success.
export async function previewVoiceOverVoice(projectId: string, input: { providerId: string; voiceId: string }): Promise<Blob> {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE_URL}/projects/${projectId}/voice-over/preview-voice`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    let detail = res.statusText || "Couldn't preview this voice.";
    try {
      const parsed: unknown = message ? JSON.parse(message) : null;
      if (parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message: unknown }).message === "string") {
        detail = (parsed as { message: string }).message;
      }
    } catch {
      // Not JSON — fall back to statusText above.
    }
    throw new ApiError(res.status, detail);
  }
  return res.blob();
}

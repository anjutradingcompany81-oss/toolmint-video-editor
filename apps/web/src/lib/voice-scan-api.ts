import { apiFetch } from "./api-client";

export type VoiceScanScope = "CLIP" | "TIMELINE";
export type VoiceScanStatus =
  | "QUEUED"
  | "EXTRACTING_AUDIO"
  | "DETECTING_SPEECH"
  | "TRANSCRIBING"
  | "DIARIZING"
  | "COMPARING"
  | "PREPARING_SUGGESTIONS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "PAUSED";
export type SensitivityPreset = "LOW" | "BALANCED" | "HIGH" | "CUSTOM";
export type RepetitionKind = "WORD" | "PHRASE" | "SENTENCE" | "CLIP_OVERLAP" | "SCENE_JOIN" | "RENDER_DUPLICATE";
export type ConfidenceBucket = "HIGH" | "MEDIUM" | "LOW";
export type CorrectionMode = "AUDIO_ONLY" | "AUDIO_VIDEO_TRIM";
export type RepetitionReviewStatus = "PENDING" | "APPLIED" | "DISMISSED";

export const ACTIVE_VOICE_SCAN_STATUSES: VoiceScanStatus[] = [
  "QUEUED",
  "EXTRACTING_AUDIO",
  "DETECTING_SPEECH",
  "TRANSCRIBING",
  "DIARIZING",
  "COMPARING",
  "PREPARING_SUGGESTIONS",
];

export const SENSITIVITY_LABELS: Record<SensitivityPreset, string> = {
  LOW: "Low",
  BALANCED: "Balanced",
  HIGH: "High",
  CUSTOM: "Custom",
};

export const STAGE_LABELS: Partial<Record<VoiceScanStatus, string>> = {
  QUEUED: "Waiting to start",
  EXTRACTING_AUDIO: "Extracting audio",
  DETECTING_SPEECH: "Detecting speech",
  TRANSCRIBING: "Transcribing dialogue",
  DIARIZING: "Identifying speakers",
  COMPARING: "Comparing repeated segments",
  PREPARING_SUGGESTIONS: "Preparing correction suggestions",
  PAUSED: "Paused",
};

export interface CustomThresholds {
  transcriptSimilarityPct: number;
  audioSimilarityPct: number;
  maxGapMs: number;
  minSegmentDurationMs: number;
  confidenceThreshold: number; // 0-100
}

export interface VoiceScanJob {
  id: string;
  projectId: string;
  scope: VoiceScanScope;
  trackId: string | null;
  clipId: string | null;
  status: VoiceScanStatus;
  stageLabel: string | null;
  progress: number;
  sensitivityPreset: SensitivityPreset;
  customThresholds: CustomThresholds | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
  errorMessage: string | null;
  requestedById: string;
  createdAt: string;
  completedAt: string | null;
}

export interface RepetitionResult {
  id: string;
  voiceScanJobId: string;
  trackId: string;
  clipId: string;
  mediaAssetId: string;
  kind: RepetitionKind;
  originalStartMs: number;
  originalEndMs: number;
  repeatedStartMs: number;
  repeatedEndMs: number;
  originalText: string;
  repeatedText: string;
  speakerLabel: string | null;
  transcriptSimilarity: number;
  audioSimilarity: number;
  timingGapMs: number;
  confidenceScore: number;
  confidenceBucket: ConfidenceBucket;
  suggestedMode: CorrectionMode;
  status: RepetitionReviewStatus;
  appliedMode: CorrectionMode | null;
  createdAt: string;
}

export interface BatchPreview {
  totalPending: number;
  highConfidencePending: number;
  needsReviewPending: number;
  estimatedDurationRemovedMs: number;
}

// One line of the full chronological transcript — `role` is set only when
// this line matches a RepetitionResult: "original" for the kept take,
// "repeated" for the flagged duplicate. Everything else about the result
// (confidence, correction status) rides along so the transcript view can
// render the same highlighting/suggestion the pairwise review cards show,
// without a second round trip.
export interface TranscriptLine {
  id: string;
  trackId: string;
  clipId: string;
  mediaAssetId: string;
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  text: string;
  edited: boolean;
  role: "original" | "repeated" | null;
  repetitionResultId: string | null;
  confidenceBucket: ConfidenceBucket | null;
  status: RepetitionReviewStatus | null;
  suggestedMode: CorrectionMode | null;
}

export function startVoiceScan(
  projectId: string,
  input: { scope: VoiceScanScope; trackId?: string; clipId?: string; sensitivityPreset?: SensitivityPreset; customThresholds?: CustomThresholds },
) {
  return apiFetch<VoiceScanJob>(`/projects/${projectId}/voice-scans`, { method: "POST", body: JSON.stringify(input) });
}

export function listVoiceScans(projectId: string) {
  return apiFetch<VoiceScanJob[]>(`/projects/${projectId}/voice-scans`);
}

export function getVoiceScan(projectId: string, jobId: string) {
  return apiFetch<VoiceScanJob>(`/projects/${projectId}/voice-scans/${jobId}`);
}

export function getVoiceScanResults(projectId: string, jobId: string) {
  return apiFetch<RepetitionResult[]>(`/projects/${projectId}/voice-scans/${jobId}/results`);
}

export function getVoiceScanTranscript(projectId: string, jobId: string) {
  return apiFetch<TranscriptLine[]>(`/projects/${projectId}/voice-scans/${jobId}/transcript`);
}

export function updateTranscriptLine(projectId: string, jobId: string, input: { mediaAssetId: string; sourceStartMs: number; text: string }) {
  return apiFetch<{ mediaAssetId: string; sourceStartMs: number; text: string; edited: boolean }>(
    `/projects/${projectId}/voice-scans/${jobId}/transcript-line`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function cancelVoiceScan(projectId: string, jobId: string) {
  return apiFetch<VoiceScanJob>(`/projects/${projectId}/voice-scans/${jobId}/cancel`, { method: "POST" });
}

export function pauseVoiceScan(projectId: string, jobId: string) {
  return apiFetch<VoiceScanJob>(`/projects/${projectId}/voice-scans/${jobId}/pause`, { method: "POST" });
}

export function resumeVoiceScan(projectId: string, jobId: string) {
  return apiFetch<VoiceScanJob>(`/projects/${projectId}/voice-scans/${jobId}/resume`, { method: "POST" });
}

export function markVoiceScanResult(projectId: string, jobId: string, resultId: string, input: { status: RepetitionReviewStatus; appliedMode?: CorrectionMode }) {
  return apiFetch<RepetitionResult>(`/projects/${projectId}/voice-scans/${jobId}/results/${resultId}/mark`, { method: "POST", body: JSON.stringify(input) });
}

export function getBatchPreview(projectId: string, jobId: string) {
  return apiFetch<BatchPreview>(`/projects/${projectId}/voice-scans/${jobId}/batch-preview`);
}

export function batchMarkResults(projectId: string, jobId: string, results: { id: string; appliedMode: CorrectionMode }[]) {
  return apiFetch<{ updated: number }>(`/projects/${projectId}/voice-scans/${jobId}/batch-mark`, {
    method: "POST",
    body: JSON.stringify({ results }),
  });
}

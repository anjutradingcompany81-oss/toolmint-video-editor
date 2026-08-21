"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaAsset } from "@/lib/projects-api";
import { addAudioPatch, removeAudioPatch, removeRangeOnTrack, type Clip, type MediaClip } from "@/lib/composition-api";
import {
  ACTIVE_VOICE_SCAN_STATUSES,
  batchMarkResults,
  cancelVoiceScan,
  getBatchPreview,
  getVoiceScan,
  getVoiceScanResults,
  getVoiceScanTranscript,
  markVoiceScanResult,
  pauseVoiceScan,
  resumeVoiceScan,
  SENSITIVITY_LABELS,
  startVoiceScan,
  STAGE_LABELS,
  type BatchPreview,
  type CorrectionMode,
  type CustomThresholds,
  type RepetitionResult,
  type SensitivityPreset,
  type TranscriptLine,
  type VoiceScanJob,
} from "@/lib/voice-scan-api";
import { ApiError } from "@/lib/api-client";
import { TrashIcon } from "@/components/icons";
import Waveform from "./waveform";
import { formatTimecode } from "./format";

export interface VoiceMarker {
  startMs: number;
  endMs: number;
  tone: "red" | "orange" | "green";
}

interface VoiceCorrectionPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  trackId: string | null;
  clips: MediaClip[];
  selectedClipId: string | null;
  mediaById: Map<string, MediaAsset>;
  onSeek: (ms: number) => void;
  withClips: (mutate: (prev: MediaClip[]) => Clip[]) => void;
  onMarkersChange: (markers: VoiceMarker[]) => void;
}

const POLL_MS = 1200;
const DEFAULT_CUSTOM: CustomThresholds = { transcriptSimilarityPct: 80, audioSimilarityPct: 65, maxGapMs: 15000, minSegmentDurationMs: 250, confidenceThreshold: 60 };

const CONFIDENCE_STYLES: Record<RepetitionResult["confidenceBucket"], string> = {
  HIGH: "border-danger/40 bg-danger/15 text-danger",
  MEDIUM: "border-amber-400/40 bg-amber-400/15 text-amber-400",
  LOW: "border-line bg-panel text-ink-muted",
};

const KIND_LABELS: Record<RepetitionResult["kind"], string> = {
  WORD: "Repeated word",
  PHRASE: "Repeated phrase",
  SENTENCE: "Repeated sentence",
  CLIP_OVERLAP: "Clip overlap",
  SCENE_JOIN: "Scene-join duplicate",
  RENDER_DUPLICATE: "Duplicate audio",
};

export default function VoiceCorrectionPanel({
  open,
  onClose,
  projectId,
  trackId,
  clips,
  selectedClipId,
  mediaById,
  onSeek,
  withClips,
  onMarkersChange,
}: VoiceCorrectionPanelProps) {
  const [sensitivity, setSensitivity] = useState<SensitivityPreset>("BALANCED");
  const [custom, setCustom] = useState<CustomThresholds>(DEFAULT_CUSTOM);
  const [job, setJob] = useState<VoiceScanJob | null>(null);
  const [results, setResults] = useState<RepetitionResult[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchPreview, setBatchPreview] = useState<BatchPreview | null>(null);
  const [batchApplying, setBatchApplying] = useState(false);
  const [viewMode, setViewMode] = useState<"suggestions" | "transcript">("suggestions");
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const clipById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const resultsById = useMemo(() => new Map(results.map((r) => [r.id, r])), [results]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    const pending = results.filter((r) => r.status === "PENDING");
    const applied = results.filter((r) => r.status === "APPLIED");
    onMarkersChange([
      ...pending.map((r) => ({ startMs: r.repeatedStartMs, endMs: r.repeatedEndMs, tone: (r.confidenceBucket === "HIGH" ? "red" : "orange") as "red" | "orange" })),
      ...applied.map((r) => ({ startMs: r.repeatedStartMs, endMs: r.repeatedEndMs, tone: "green" as const })),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  function stopPolling() {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }

  const poll = useCallback(
    (jobId: string) => {
      stopPolling();
      pollTimer.current = setInterval(async () => {
        try {
          const updated = await getVoiceScan(projectId, jobId);
          setJob(updated);
          if (!ACTIVE_VOICE_SCAN_STATUSES.includes(updated.status)) {
            stopPolling();
            if (updated.status === "COMPLETED") setResults(await getVoiceScanResults(projectId, jobId));
          }
        } catch {
          stopPolling();
        }
      }, POLL_MS);
    },
    [projectId],
  );

  async function startScan(scope: "CLIP" | "TIMELINE") {
    setError(null);
    setResults([]);
    setViewMode("suggestions");
    setTranscript(null);
    setStarting(true);
    try {
      const created = await startVoiceScan(projectId, {
        scope,
        trackId: scope === "CLIP" ? (trackId ?? undefined) : undefined,
        clipId: scope === "CLIP" ? (selectedClipId ?? undefined) : undefined,
        sensitivityPreset: sensitivity,
        customThresholds: sensitivity === "CUSTOM" ? custom : undefined,
      });
      setJob(created);
      poll(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the scan.");
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!job) return;
    try {
      setJob(await cancelVoiceScan(projectId, job.id));
    } catch {
      // next poll (or the fact polling already stopped) reconciles either way
    }
  }
  async function handlePause() {
    if (!job) return;
    setJob(await pauseVoiceScan(projectId, job.id));
  }
  async function handleResume() {
    if (!job) return;
    const resumed = await resumeVoiceScan(projectId, job.id);
    setJob(resumed);
    poll(job.id);
  }

  // Real audio from the actual source file, not a synthesized preview:
  // "Before" plays the repeated (duplicate) take itself, in context;
  // "After" plays the original take that will remain once the duplicate
  // is corrected — an honest A/B of the two recordings rather than a full
  // rendered-timeline preview (which would need a server round trip).
  function play(result: RepetitionResult, which: "before" | "after") {
    const clip = clipById.get(result.clipId);
    const asset = clip ? mediaById.get(clip.mediaAssetId) : undefined;
    if (!clip || !asset?.previewUrl) return;
    const [startMs, endMs] = which === "before" ? [result.repeatedStartMs, result.repeatedEndMs] : [result.originalStartMs, result.originalEndMs];
    const sourceStartS = (clip.trimInMs + Math.max(0, startMs - clip.startMs)) / 1000;
    const durationS = Math.max(0.2, (endMs - startMs) / 1000);

    const audio = audioRef.current;
    if (!audio) return;
    if (audio.src !== asset.previewUrl) audio.src = asset.previewUrl;
    audio.currentTime = sourceStartS;
    audio.play().catch(() => undefined);
    window.setTimeout(() => audio.pause(), durationS * 1000 + 150);
  }

  function dismiss(result: RepetitionResult) {
    setResults((prev) => prev.map((r) => (r.id === result.id ? { ...r, status: "DISMISSED" } : r)));
    markVoiceScanResult(projectId, job!.id, result.id, { status: "DISMISSED" }).catch(() => undefined);
  }

  function applyOne(result: RepetitionResult, mode: CorrectionMode) {
    const clip = clipById.get(result.clipId);
    if (!clip) {
      setError("That clip no longer exists on the timeline — the timeline may have changed since this scan ran.");
      return;
    }
    if (mode === "AUDIO_VIDEO_TRIM") {
      const cutResult = removeRangeOnTrack(clips, result.trackId, () => mediaById.get(clip.mediaAssetId)?.durationMs ?? 0, result.repeatedStartMs, result.repeatedEndMs);
      if (!cutResult.ok) {
        setError(cutResult.message);
        return;
      }
      withClips(() => cutResult.clips);
    } else {
      const localStart = result.repeatedStartMs - clip.startMs;
      const localEnd = result.repeatedEndMs - clip.startMs;
      withClips((prev) => addAudioPatch(prev, clip.id, { startMs: localStart, endMs: localEnd, repetitionResultId: result.id }));
    }
    setResults((prev) => prev.map((r) => (r.id === result.id ? { ...r, status: "APPLIED", appliedMode: mode } : r)));
    markVoiceScanResult(projectId, job!.id, result.id, { status: "APPLIED", appliedMode: mode }).catch(() => undefined);
  }

  function undoOne(result: RepetitionResult) {
    if (result.appliedMode === "AUDIO_ONLY") {
      withClips((prev) => removeAudioPatch(prev, result.clipId, result.id));
    }
    // An AUDIO_VIDEO_TRIM correction already ripple-closed the gap — the
    // normal editor Undo (Ctrl+Z) is what reverses that, since it's just
    // another timeline edit in the same history stack. Reopening this
    // result at least lets the user re-review or re-dismiss it.
    setResults((prev) => prev.map((r) => (r.id === result.id ? { ...r, status: "PENDING" } : r)));
    markVoiceScanResult(projectId, job!.id, result.id, { status: "PENDING" }).catch(() => undefined);
  }

  async function openBatchModal() {
    if (!job) return;
    setBatchPreview(await getBatchPreview(projectId, job.id));
  }

  // Lazy — only fetched the first time the user actually switches to the
  // Transcript tab, since a long video's full transcript is a much bigger
  // payload than the (usually short) list of flagged repetitions the
  // panel shows by default.
  async function switchToTranscript() {
    setViewMode("transcript");
    if (!job || transcript !== null || transcriptLoading) return;
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      setTranscript(await getVoiceScanTranscript(projectId, job.id));
    } catch (err) {
      setTranscriptError(err instanceof ApiError ? err.message : "Couldn't load the transcript.");
    } finally {
      setTranscriptLoading(false);
    }
  }

  async function confirmBatch() {
    if (!job) return;
    setBatchApplying(true);
    try {
      const highConfidence = results.filter((r) => r.status === "PENDING" && r.confidenceBucket === "HIGH");
      let nextClips: Clip[] = clips;
      const applied: { id: string; appliedMode: CorrectionMode }[] = [];

      for (const result of highConfidence) {
        const clip = nextClips.find((c) => c.id === result.clipId) as MediaClip | undefined;
        if (!clip) continue;
        if (result.suggestedMode === "AUDIO_VIDEO_TRIM") {
          const cutResult = removeRangeOnTrack(nextClips, result.trackId, () => mediaById.get(clip.mediaAssetId)?.durationMs ?? 0, result.repeatedStartMs, result.repeatedEndMs);
          if (cutResult.ok) nextClips = cutResult.clips;
        } else {
          const localStart = result.repeatedStartMs - clip.startMs;
          const localEnd = result.repeatedEndMs - clip.startMs;
          nextClips = addAudioPatch(nextClips, clip.id, { startMs: localStart, endMs: localEnd, repetitionResultId: result.id });
        }
        applied.push({ id: result.id, appliedMode: result.suggestedMode });
      }

      withClips(() => nextClips);
      setResults((prev) => prev.map((r) => (applied.some((a) => a.id === r.id) ? { ...r, status: "APPLIED", appliedMode: r.suggestedMode } : r)));
      if (applied.length > 0) await batchMarkResults(projectId, job.id, applied);
      setBatchPreview(null);
    } finally {
      setBatchApplying(false);
    }
  }

  if (!open) return null;

  const active = job ? ACTIVE_VOICE_SCAN_STATUSES.includes(job.status) : false;
  const pendingResults = results.filter((r) => r.status === "PENDING").sort((a, b) => a.repeatedStartMs - b.repeatedStartMs);
  const correctedCount = results.filter((r) => r.status === "APPLIED").length;

  return (
    <aside className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[420px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <audio ref={audioRef} className="hidden" />

      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">AI Voice Correction</h2>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!job && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">
              Scan the timeline for accidentally duplicated words, phrases, or sentences — supports Hindi, English, and mixed Hindi-English speech.
            </p>

            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Sensitivity
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as SensitivityPreset)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
              >
                {(Object.keys(SENSITIVITY_LABELS) as SensitivityPreset[]).map((s) => (
                  <option key={s} value={s}>
                    {SENSITIVITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            {sensitivity === "CUSTOM" && (
              <div className="flex flex-col gap-2 rounded-md border border-line p-2.5 text-xs text-ink-muted">
                <CustomSlider label="Transcript similarity" value={custom.transcriptSimilarityPct} unit="%" onChange={(v) => setCustom((c) => ({ ...c, transcriptSimilarityPct: v }))} />
                <CustomSlider label="Audio similarity" value={custom.audioSimilarityPct} unit="%" onChange={(v) => setCustom((c) => ({ ...c, audioSimilarityPct: v }))} />
                <CustomSlider label="Max gap between repeats" value={custom.maxGapMs / 1000} unit="s" max={60} onChange={(v) => setCustom((c) => ({ ...c, maxGapMs: v * 1000 }))} />
                <CustomSlider label="Min segment duration" value={custom.minSegmentDurationMs} unit="ms" max={2000} onChange={(v) => setCustom((c) => ({ ...c, minSegmentDurationMs: v }))} />
                <CustomSlider label="Confidence threshold" value={custom.confidenceThreshold} unit="%" onChange={(v) => setCustom((c) => ({ ...c, confidenceThreshold: v }))} />
              </div>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={() => startScan("CLIP")}
                disabled={starting || !selectedClipId}
                title={selectedClipId ? "Scan the selected clip" : "Select a clip on the timeline first"}
                className="rounded-md border border-line px-3 py-2 text-sm text-ink hover:border-brand disabled:opacity-40"
              >
                Scan Selected Clip
              </button>
              <button
                onClick={() => startScan("TIMELINE")}
                disabled={starting || clips.length === 0}
                className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-ink hover:bg-brand/90 disabled:opacity-40"
              >
                Scan Entire Timeline
              </button>
            </div>
          </div>
        )}

        {job && active && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink">{job.stageLabel ?? STAGE_LABELS[job.status] ?? "Working…"}</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${job.progress}%` }} />
            </div>
            <div className="flex gap-2">
              <button onClick={handlePause} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
                Pause
              </button>
              <button onClick={handleCancel} className="rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10">
                Cancel
              </button>
            </div>
          </div>
        )}

        {job && job.status === "PAUSED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">Scan paused — already-processed audio won&apos;t be reprocessed when you resume.</p>
            <div className="flex gap-2">
              <button onClick={handleResume} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand/90">
                Resume
              </button>
              <button onClick={handleCancel} className="rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10">
                Cancel
              </button>
            </div>
          </div>
        )}

        {job && job.status === "FAILED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-danger">{job.errorMessage ?? "The scan failed."}</p>
            <button onClick={() => setJob(null)} className="self-start rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
              Try again
            </button>
          </div>
        )}

        {job && job.status === "CANCELLED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">Scan cancelled.</p>
            <button onClick={() => setJob(null)} className="self-start rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
              Back
            </button>
          </div>
        )}

        {job && job.status === "COMPLETED" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                {results.length === 0
                  ? "No repetitions detected."
                  : `${pendingResults.length} to review · ${correctedCount} corrected`}
              </p>
              <button onClick={() => setJob(null)} className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink">
                New scan
              </button>
            </div>

            <div className="flex gap-1 rounded-md border border-line bg-panel p-0.5 text-xs">
              <button
                onClick={() => setViewMode("suggestions")}
                className={`flex-1 rounded py-1.5 font-medium ${viewMode === "suggestions" ? "bg-brand text-ink" : "text-ink-muted hover:text-ink"}`}
              >
                Suggestions
              </button>
              <button
                onClick={switchToTranscript}
                className={`flex-1 rounded py-1.5 font-medium ${viewMode === "transcript" ? "bg-brand text-ink" : "text-ink-muted hover:text-ink"}`}
              >
                Full Transcript
              </button>
            </div>

            {viewMode === "suggestions" ? (
              <>
                {pendingResults.some((r) => r.confidenceBucket === "HIGH") && (
                  <button onClick={openBatchModal} className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-ink hover:bg-brand/90">
                    Correct All High-Confidence Repetitions
                  </button>
                )}

                <div className="flex flex-col gap-3">
                  {pendingResults.map((result) => (
                    <ResultCard
                      key={result.id}
                      result={result}
                      asset={(() => {
                        const clip = clipById.get(result.clipId);
                        return clip ? mediaById.get(clip.mediaAssetId) : undefined;
                      })()}
                      onSeek={() => onSeek(result.repeatedStartMs)}
                      onPlayBefore={() => play(result, "before")}
                      onPlayAfter={() => play(result, "after")}
                      onKeep={() => dismiss(result)}
                      onRemove={() => applyOne(result, result.suggestedMode)}
                      onRoomTone={() => applyOne(result, "AUDIO_ONLY")}
                      onTrim={() => applyOne(result, "AUDIO_VIDEO_TRIM")}
                    />
                  ))}

                  {results
                    .filter((r) => r.status === "APPLIED")
                    .map((result) => (
                      <div key={result.id} className="flex items-center justify-between rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs">
                        <span className="truncate text-ink-muted">
                          <span className="text-success">Corrected</span> · &quot;{result.repeatedText}&quot; at {formatTimecode(result.repeatedStartMs, true)}
                        </span>
                        <button onClick={() => undoOne(result)} className="shrink-0 text-ink-muted underline underline-offset-2 hover:text-ink">
                          Undo
                        </button>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <TranscriptView
                loading={transcriptLoading}
                error={transcriptError}
                lines={transcript}
                resultsById={resultsById}
                onSeek={onSeek}
                onKeep={dismiss}
                onCorrect={(result) => applyOne(result, result.suggestedMode)}
              />
            )}
          </div>
        )}
      </div>

      {batchPreview && job && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setBatchPreview(null)}>
          <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-line bg-panel p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-ink">Correct all high-confidence repetitions?</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-muted">Repetitions detected</dt>
              <dd className="text-right text-ink">{batchPreview.totalPending}</dd>
              <dt className="text-ink-muted">Selected for correction</dt>
              <dd className="text-right text-ink">{batchPreview.highConfidencePending}</dd>
              <dt className="text-ink-muted">Duration removed/repaired</dt>
              <dd className="text-right text-ink">{formatTimecode(batchPreview.estimatedDurationRemovedMs, true)}</dd>
            </dl>
            {batchPreview.needsReviewPending > 0 && (
              <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-400">
                {batchPreview.needsReviewPending} additional result(s) need manual review and won&apos;t be touched by this action.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setBatchPreview(null)} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink hover:border-brand/60">
                Cancel
              </button>
              <button
                onClick={confirmBatch}
                disabled={batchApplying}
                className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-ink hover:bg-brand/90 disabled:opacity-50"
              >
                {batchApplying ? "Applying…" : "Correct all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function CustomSlider({ label, value, unit, max = 100, onChange }: { label: string; value: number; unit: string; max?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-ink">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-brand" />
    </label>
  );
}

function ResultCard({
  result,
  asset,
  onSeek,
  onPlayBefore,
  onPlayAfter,
  onKeep,
  onRemove,
  onRoomTone,
  onTrim,
}: {
  result: RepetitionResult;
  asset: MediaAsset | undefined;
  onSeek: () => void;
  onPlayBefore: () => void;
  onPlayAfter: () => void;
  onKeep: () => void;
  onRemove: () => void;
  onRoomTone: () => void;
  onTrim: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-panel p-3 text-sm">
      <div className="flex items-center justify-between">
        <button onClick={onSeek} className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline">
          {KIND_LABELS[result.kind]} · {formatTimecode(result.repeatedStartMs, true)}
        </button>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${CONFIDENCE_STYLES[result.confidenceBucket]}`}>
          {result.confidenceBucket} · {Math.round(result.confidenceScore * 100)}%
        </span>
      </div>

      {result.speakerLabel && <p className="text-xs text-ink-muted">Speaker: {result.speakerLabel}</p>}

      <div className="flex flex-col gap-1">
        <p className="truncate text-ink-muted" title={result.originalText}>
          Original: <span className="text-ink">&quot;{result.originalText}&quot;</span>
        </p>
        <p className="truncate text-ink-muted" title={result.repeatedText}>
          Repeated: <span className="text-ink">&quot;{result.repeatedText}&quot;</span>
        </p>
      </div>

      {asset?.waveformPeaks && (
        <Waveform
          peaks={asset.waveformPeaks}
          sourceDurationMs={asset.durationMs}
          trimInMs={Math.max(0, result.repeatedStartMs - 500)}
          durationMs={result.repeatedEndMs - result.repeatedStartMs + 1000}
          className="h-6 w-full text-brand"
        />
      )}

      <div className="flex gap-2">
        <button onClick={onPlayBefore} className="flex-1 rounded-md border border-line py-1 text-xs text-ink hover:border-brand">
          Play Before
        </button>
        <button onClick={onPlayAfter} className="flex-1 rounded-md border border-line py-1 text-xs text-ink hover:border-brand">
          Play After
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={onKeep} className="rounded-md border border-line py-1 text-xs text-ink hover:border-brand">
          Keep Original
        </button>
        <button onClick={onRemove} className="rounded-md bg-danger py-1 text-xs font-medium text-ink hover:bg-danger/90">
          Remove Duplicate
        </button>
        <button onClick={onRoomTone} className="rounded-md border border-line py-1 text-xs text-ink hover:border-brand">
          Replace with Room Tone
        </button>
        <button onClick={onTrim} className="flex items-center justify-center gap-1 rounded-md border border-line py-1 text-xs text-ink hover:border-brand">
          <TrashIcon width={11} height={11} /> Trim Audio &amp; Video
        </button>
      </div>
    </div>
  );
}

const SUGGESTION_COPY: Record<CorrectionMode, string> = {
  AUDIO_VIDEO_TRIM: "Suggested fix: cut this line out entirely (audio & video).",
  AUDIO_ONLY: "Suggested fix: replace this line's audio with room tone (video keeps playing).",
};

// The full scanned transcript in chronological order, in whatever script
// Whisper produced (Hindi audio currently transcribes correctly but in
// Urdu/Perso-Arabic script rather than Devanagari — a known model
// limitation, not a bug in this view) — every line involved in a detected
// repetition is highlighted directly in place, with the "kept" line and
// the flagged duplicate both visible together so the mistake reads the
// same way a person proofreading the script would spot it.
function TranscriptView({
  loading,
  error,
  lines,
  resultsById,
  onSeek,
  onKeep,
  onCorrect,
}: {
  loading: boolean;
  error: string | null;
  lines: TranscriptLine[] | null;
  resultsById: Map<string, RepetitionResult>;
  onSeek: (ms: number) => void;
  onKeep: (result: RepetitionResult) => void;
  onCorrect: (result: RepetitionResult) => void;
}) {
  if (loading) return <p className="text-sm text-ink-muted">Loading transcript…</p>;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!lines || lines.length === 0) return <p className="text-sm text-ink-muted">No transcript available for this scan.</p>;

  return (
    <div className="flex flex-col gap-1">
      {lines.map((line) => {
        const result = line.repetitionResultId ? resultsById.get(line.repetitionResultId) : undefined;
        const isFlaggedRepeat = line.role === "repeated" && result && result.status === "PENDING";
        const isResolvedRepeat = line.role === "repeated" && result && result.status !== "PENDING";

        return (
          <div key={line.id} className="flex flex-col gap-1">
            <button
              onClick={() => onSeek(line.startMs)}
              dir="auto"
              className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                isFlaggedRepeat
                  ? result!.confidenceBucket === "HIGH"
                    ? "bg-danger/15 text-ink"
                    : "bg-amber-400/15 text-ink"
                  : isResolvedRepeat
                    ? result!.status === "APPLIED"
                      ? "bg-success/10 text-ink-muted line-through decoration-success/60"
                      : "text-ink-muted"
                    : line.role === "original"
                      ? "border-l-2 border-brand/50 bg-brand/5 text-ink"
                      : "text-ink hover:bg-panel"
              }`}
            >
              <span className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-ink-muted">{formatTimecode(line.startMs, true)}</span>
              <span className="flex-1">{line.text}</span>
            </button>

            {isFlaggedRepeat && (
              <div className="ml-2 flex flex-col gap-1.5 rounded-md border border-line bg-panel px-2.5 py-2 text-xs">
                <p className="text-ink-muted">{SUGGESTION_COPY[result!.suggestedMode]}</p>
                <div className="flex gap-1.5">
                  <button onClick={() => onKeep(result!)} className="flex-1 rounded border border-line py-1 text-ink hover:border-brand">
                    Keep Original
                  </button>
                  <button onClick={() => onCorrect(result!)} className="flex-1 rounded bg-danger py-1 font-medium text-ink hover:bg-danger/90">
                    Apply Fix
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

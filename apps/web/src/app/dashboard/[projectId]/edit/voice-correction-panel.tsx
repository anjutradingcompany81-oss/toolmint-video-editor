"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaAsset } from "@/lib/projects-api";
import { addAudioPatch, removeAudioPatch, removeRangeOnTrack, resolveSourceRange, type Clip, type MediaClip } from "@/lib/composition-api";
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
  updateTranscriptLine,
  type BatchPreview,
  type CorrectionMode,
  type CustomThresholds,
  type RepetitionResult,
  type SensitivityPreset,
  type TranscriptLine,
  type VoiceScanJob,
} from "@/lib/voice-scan-api";
import { ApiError } from "@/lib/api-client";
import { MicWaveIcon, PencilIcon, RedoIcon, TrashIcon, UndoIcon } from "@/components/icons";
import Waveform from "./waveform";
import { formatTimecode } from "./format";
import { LANGUAGE_LABELS, VOICE_CORRECTION_STRINGS, type DisplayLang, type VoiceCorrectionStrings } from "./voice-correction-i18n";

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
const DISPLAY_LANG_STORAGE_KEY = "procut:voice-correction:display-lang";

// Per spec: below 90% shown confidence, present the item as "Review
// Required" regardless of the underlying HIGH/MEDIUM/LOW bucket colour —
// a purely presentational relabelling layered on top of the existing,
// well-tested bucket/threshold system (SENSITIVITY_PRESETS,
// repetition-detector.util.ts), not a change to what gets auto-applied by
// "Correct All High-Confidence".
function confidenceLabel(score: number, bucket: RepetitionResult["confidenceBucket"], t: VoiceCorrectionStrings): string {
  if (score * 100 < 90) return t.reviewRequired;
  return bucket;
}

const CONFIDENCE_STYLES: Record<RepetitionResult["confidenceBucket"], string> = {
  HIGH: "border-danger/40 bg-danger/15 text-danger",
  MEDIUM: "border-amber-400/40 bg-amber-400/15 text-amber-400",
  LOW: "border-line bg-panel text-ink-muted",
};

function kindLabel(kind: RepetitionResult["kind"], t: VoiceCorrectionStrings): string {
  return {
    WORD: t.kindWord,
    PHRASE: t.kindPhrase,
    SENTENCE: t.kindSentence,
    CLIP_OVERLAP: t.kindClipOverlap,
    SCENE_JOIN: t.kindSceneJoin,
    RENDER_DUPLICATE: t.kindRenderDuplicate,
  }[kind];
}

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
  const [displayLang, setDisplayLang] = useState<DisplayLang>("en");
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
  const [editHistory, setEditHistory] = useState<{ lineId: string; mediaAssetId: string; sourceStartMs: number; prevText: string; nextText: string }[]>([]);
  const [redoStack, setRedoStack] = useState<typeof editHistory>([]);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const t = VOICE_CORRECTION_STRINGS[displayLang];
  const clipById = useMemo(() => new Map(clips.map((c) => [c.id, c])), [clips]);
  const resultsById = useMemo(() => new Map(results.map((r) => [r.id, r])), [results]);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? (window.localStorage.getItem(DISPLAY_LANG_STORAGE_KEY) as DisplayLang | null) : null;
    if (saved === "en" || saved === "hi") setDisplayLang(saved);
  }, []);

  function changeDisplayLang(lang: DisplayLang) {
    setDisplayLang(lang);
    if (typeof window !== "undefined") window.localStorage.setItem(DISPLAY_LANG_STORAGE_KEY, lang);
  }

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
    setEditHistory([]);
    setRedoStack([]);
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

  // Where a scan result currently lives on the timeline. Prefers the
  // source-file offsets (immutable across edits); falls back to the clip id
  // + timeline position for results recorded before those were stored.
  const resolveTarget = useCallback(
    (result: RepetitionResult) => {
      if (result.sourceRepeatedStartMs != null && result.sourceRepeatedEndMs != null) {
        return resolveSourceRange(clips, result.mediaAssetId, result.sourceRepeatedStartMs, result.sourceRepeatedEndMs);
      }
      const clip = clipById.get(result.clipId);
      if (!clip) return null;
      return {
        clip,
        localStartMs: result.repeatedStartMs - clip.startMs,
        localEndMs: result.repeatedEndMs - clip.startMs,
        timelineStartMs: result.repeatedStartMs,
        timelineEndMs: result.repeatedEndMs,
      };
    },
    [clips, clipById],
  );

  function dismiss(result: RepetitionResult) {
    setResults((prev) => prev.map((r) => (r.id === result.id ? { ...r, status: "DISMISSED" } : r)));
    markVoiceScanResult(projectId, job!.id, result.id, { status: "DISMISSED" }).catch(() => undefined);
  }

  function applyOne(result: RepetitionResult, mode: CorrectionMode) {
    // Locate the correction by where it sits in the SOURCE file rather than
    // by the clip id and timeline position captured at scan time — those go
    // stale as soon as anything is cut, split or moved, which is what made
    // this report "That clip no longer exists on the timeline" even though
    // the media was still right there. Older results (scanned before source
    // offsets were recorded) fall back to the original clip lookup.
    const target = resolveTarget(result);
    if (!target) {
      setError(
        result.sourceRepeatedStartMs == null
          ? "This result came from an older scan and can't be located after the timeline changed. Run a new scan and try again."
          : "That part of the recording is no longer on the timeline — it looks like it was cut. Run a new scan and try again.",
      );
      return;
    }
    const { clip, localStartMs, localEndMs, timelineStartMs, timelineEndMs } = target;

    if (mode === "AUDIO_VIDEO_TRIM") {
      const cutResult = removeRangeOnTrack(clips, clip.trackId, () => mediaById.get(clip.mediaAssetId)?.durationMs ?? 0, timelineStartMs, timelineEndMs);
      if (!cutResult.ok) {
        setError(cutResult.message);
        return;
      }
      withClips(() => cutResult.clips);
    } else {
      // Validate against the CURRENT clip before touching editor state: a
      // result whose coordinates no longer fit (because the timeline was
      // edited after the scan) would otherwise be written anyway, get
      // rejected by the server, and then block every later autosave.
      const patched = addAudioPatch(clips, clip.id, { startMs: localStartMs, endMs: localEndMs, repetitionResultId: result.id });
      if (!patched.ok) {
        setError(patched.message);
        return;
      }
      withClips(() => patched.clips);
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
    setError(null);
    try {
      setBatchPreview(await getBatchPreview(projectId, job.id));
    } catch (err) {
      // Was previously unhandled — a failed fetch here left the button
      // looking like it did nothing at all, no modal and no error either.
      setError(err instanceof ApiError ? err.message : "Couldn't load the batch preview.");
    }
  }

  // Lazy — only fetched the first time the user actually switches to the
  // Script tab, since a long video's full transcript is a much bigger
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

  // Saves a manual text correction to one transcript line (fixing what
  // the script *reads*, independent of the audio/video repetition-removal
  // flow) and pushes it onto the local undo stack. Never touches the
  // video/audio — per spec, only "Apply Correction"/"Apply All Approved
  // Corrections" (the existing applyOne/confirmBatch flows) do that.
  async function saveLineEdit(line: TranscriptLine, nextText: string) {
    if (nextText === line.text) return;
    const prevText = line.text;
    setTranscript((prev) => (prev ? prev.map((l) => (l.id === line.id ? { ...l, text: nextText, edited: nextText !== prevText } : l)) : prev));
    setEditHistory((h) => [...h, { lineId: line.id, mediaAssetId: line.mediaAssetId, sourceStartMs: line.sourceStartMs, prevText, nextText }]);
    setRedoStack([]);
    try {
      await updateTranscriptLine(projectId, job!.id, { mediaAssetId: line.mediaAssetId, sourceStartMs: line.sourceStartMs, text: nextText });
    } catch (err) {
      // Roll back the optimistic update on failure, keep the history stack honest.
      setTranscript((prev) => (prev ? prev.map((l) => (l.id === line.id ? { ...l, text: prevText, edited: false } : l)) : prev));
      setEditHistory((h) => h.slice(0, -1));
      setTranscriptError(err instanceof ApiError ? err.message : "Couldn't save that edit.");
    }
  }

  async function undoEdit() {
    const last = editHistory[editHistory.length - 1];
    if (!last) return;
    setEditHistory((h) => h.slice(0, -1));
    setRedoStack((r) => [...r, last]);
    setTranscript((prev) => (prev ? prev.map((l) => (l.id === last.lineId ? { ...l, text: last.prevText, edited: last.prevText !== "" } : l)) : prev));
    await updateTranscriptLine(projectId, job!.id, { mediaAssetId: last.mediaAssetId, sourceStartMs: last.sourceStartMs, text: last.prevText }).catch(() => undefined);
  }

  async function redoEdit() {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    setRedoStack((r) => r.slice(0, -1));
    setEditHistory((h) => [...h, last]);
    setTranscript((prev) => (prev ? prev.map((l) => (l.id === last.lineId ? { ...l, text: last.nextText, edited: true } : l)) : prev));
    await updateTranscriptLine(projectId, job!.id, { mediaAssetId: last.mediaAssetId, sourceStartMs: last.sourceStartMs, text: last.nextText }).catch(() => undefined);
  }

  async function confirmBatch() {
    if (!job) return;
    setBatchApplying(true);
    setError(null);
    try {
      const highConfidence = results.filter((r) => r.status === "PENDING" && r.confidenceBucket === "HIGH");
      let nextClips: Clip[] = clips;
      const applied: { id: string; appliedMode: CorrectionMode }[] = [];
      let skipped = 0;

      for (const result of highConfidence) {
        // Re-resolve against the running `nextClips`, not the clips this
        // batch started with — each applied correction can re-cut the track
        // and shift everything after it.
        const target =
          result.sourceRepeatedStartMs != null && result.sourceRepeatedEndMs != null
            ? resolveSourceRange(nextClips, result.mediaAssetId, result.sourceRepeatedStartMs, result.sourceRepeatedEndMs)
            : (() => {
                const clip = nextClips.find((c) => c.id === result.clipId) as MediaClip | undefined;
                return clip
                  ? {
                      clip,
                      localStartMs: result.repeatedStartMs - clip.startMs,
                      localEndMs: result.repeatedEndMs - clip.startMs,
                      timelineStartMs: result.repeatedStartMs,
                      timelineEndMs: result.repeatedEndMs,
                    }
                  : null;
              })();

        if (!target) {
          skipped++;
          continue;
        }

        if (result.suggestedMode === "AUDIO_VIDEO_TRIM") {
          const cutResult = removeRangeOnTrack(
            nextClips,
            target.clip.trackId,
            () => mediaById.get(target.clip.mediaAssetId)?.durationMs ?? 0,
            target.timelineStartMs,
            target.timelineEndMs,
          );
          if (!cutResult.ok) {
            // Previously this silently skipped applying the fix but still
            // recorded it as "applied" below — the card would show as
            // corrected while nothing on the timeline actually changed.
            skipped++;
            continue;
          }
          nextClips = cutResult.clips;
        } else {
          const patched = addAudioPatch(nextClips, target.clip.id, {
            startMs: target.localStartMs,
            endMs: target.localEndMs,
            repetitionResultId: result.id,
          });
          if (!patched.ok) {
            skipped++;
            continue;
          }
          nextClips = patched.clips;
        }
        applied.push({ id: result.id, appliedMode: result.suggestedMode });
      }

      if (applied.length > 0) {
        withClips(() => nextClips);
        setResults((prev) => prev.map((r) => (applied.some((a) => a.id === r.id) ? { ...r, status: "APPLIED", appliedMode: r.suggestedMode } : r)));
        await batchMarkResults(projectId, job.id, applied);
      }
      if (skipped > 0) {
        setError(`${skipped} of ${highConfidence.length} corrections couldn't be applied (their clip may have changed since the scan ran) — the rest were applied.`);
      }
      setBatchPreview(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't apply the batch correction.");
    } finally {
      setBatchApplying(false);
    }
  }

  if (!open) return null;

  const active = job ? ACTIVE_VOICE_SCAN_STATUSES.includes(job.status) : false;
  const pendingResults = results.filter((r) => r.status === "PENDING").sort((a, b) => a.repeatedStartMs - b.repeatedStartMs);
  const correctedCount = results.filter((r) => r.status === "APPLIED").length;

  const STAGE_LABELS: Partial<Record<VoiceScanJob["status"], string>> = {
    QUEUED: t.stageQueued,
    EXTRACTING_AUDIO: t.stageExtracting,
    DETECTING_SPEECH: t.stageDetecting,
    TRANSCRIBING: t.stageTranscribing,
    DIARIZING: t.stageDiarizing,
    COMPARING: t.stageComparing,
    PREPARING_SUGGESTIONS: t.stagePreparing,
    PAUSED: t.stagePaused,
  };

  return (
    <aside dir="ltr" className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[440px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <audio ref={audioRef} className="hidden" />

      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand/15 text-brand">
            <MicWaveIcon width={16} height={16} />
          </span>
          <h2 className="text-sm font-semibold text-ink">{t.panelTitle}</h2>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle value={displayLang} onChange={changeDisplayLang} />
          <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
            {t.close}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!job && (
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-ink-muted">{t.intro}</p>

            <label className="flex flex-col gap-1.5 text-sm text-ink-muted">
              {t.sensitivity}
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as SensitivityPreset)}
                className="rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
              >
                {(Object.keys(SENSITIVITY_LABELS) as SensitivityPreset[]).map((s) => (
                  <option key={s} value={s}>
                    {SENSITIVITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            {sensitivity === "CUSTOM" && (
              <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-panel/60 p-3 text-xs text-ink-muted">
                <CustomSlider label={t.transcriptSimilarity} value={custom.transcriptSimilarityPct} unit="%" onChange={(v) => setCustom((c) => ({ ...c, transcriptSimilarityPct: v }))} />
                <CustomSlider label={t.audioSimilarity} value={custom.audioSimilarityPct} unit="%" onChange={(v) => setCustom((c) => ({ ...c, audioSimilarityPct: v }))} />
                <CustomSlider label={t.maxGap} value={custom.maxGapMs / 1000} unit="s" max={60} onChange={(v) => setCustom((c) => ({ ...c, maxGapMs: v * 1000 }))} />
                <CustomSlider label={t.minSegmentDuration} value={custom.minSegmentDurationMs} unit="ms" max={2000} onChange={(v) => setCustom((c) => ({ ...c, minSegmentDurationMs: v }))} />
                <CustomSlider label={t.confidenceThreshold} value={custom.confidenceThreshold} unit="%" onChange={(v) => setCustom((c) => ({ ...c, confidenceThreshold: v }))} />
              </div>
            )}

            {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={() => startScan("CLIP")}
                disabled={starting || !selectedClipId}
                title={selectedClipId ? t.scanSelectedClipHint : t.selectClipFirst}
                className="rounded-lg border border-line px-3 py-2.5 text-sm font-medium text-ink transition-colors hover:border-brand disabled:opacity-40"
              >
                {t.scanSelectedClip}
              </button>
              <button
                onClick={() => startScan("TIMELINE")}
                disabled={starting || clips.length === 0}
                className="rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink shadow-sm transition-colors hover:bg-brand/90 disabled:opacity-40"
              >
                {t.scanEntireTimeline}
              </button>
            </div>
          </div>
        )}

        {job && active && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink">{job.stageLabel ?? STAGE_LABELS[job.status] ?? "…"}</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${job.progress}%` }} />
            </div>
            <div className="flex gap-2">
              <button onClick={handlePause} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
                {t.pause}
              </button>
              <button onClick={handleCancel} className="rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10">
                {t.cancel}
              </button>
            </div>
          </div>
        )}

        {job && job.status === "PAUSED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{t.paused}</p>
            <div className="flex gap-2">
              <button onClick={handleResume} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-ink hover:bg-brand/90">
                {t.resume}
              </button>
              <button onClick={handleCancel} className="rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10">
                {t.cancel}
              </button>
            </div>
          </div>
        )}

        {job && job.status === "FAILED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-danger">{job.errorMessage ?? t.scanFailed}</p>
            <button onClick={() => setJob(null)} className="self-start rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
              {t.tryAgain}
            </button>
          </div>
        )}

        {job && job.status === "CANCELLED" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-muted">{t.scanCancelled}</p>
            <button onClick={() => setJob(null)} className="self-start rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
              {t.back}
            </button>
          </div>
        )}

        {job && job.status === "COMPLETED" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-ink-muted">
                {results.length === 0 ? t.noRepetitions : `${t.toReview(pendingResults.length)} · ${t.corrected(correctedCount)}`}
              </p>
              <button onClick={() => setJob(null)} className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink">
                {t.newScan}
              </button>
            </div>

            {error && (
              // Was previously only rendered on the pre-scan screen — a
              // failed "Remove Duplicate" or "Correct All" click here had
              // nowhere to show its message, so it looked like the button
              // silently did nothing at all.
              <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
            )}

            <div className="flex gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
              <button
                onClick={() => setViewMode("suggestions")}
                className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${viewMode === "suggestions" ? "bg-brand text-ink" : "text-ink-muted hover:text-ink"}`}
              >
                {t.suggestionsTab}
              </button>
              <button
                onClick={switchToTranscript}
                className={`flex-1 rounded-md py-1.5 font-medium transition-colors ${viewMode === "transcript" ? "bg-brand text-ink" : "text-ink-muted hover:text-ink"}`}
              >
                {t.scriptTab}
              </button>
            </div>

            {viewMode === "suggestions" ? (
              <>
                {results.length === 0 && <EmptyStateNotice message={t.noRepetitionDetected} />}

                {pendingResults.some((r) => r.confidenceBucket === "HIGH") && (
                  <button onClick={openBatchModal} className="rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink shadow-sm hover:bg-brand/90">
                    {t.correctAllHighConfidence}
                  </button>
                )}

                <div className="flex flex-col gap-3">
                  {pendingResults.map((result) => (
                    <ResultCard
                      key={result.id}
                      t={t}
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
                      <div key={result.id} className="flex items-center justify-between rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs">
                        <span className="truncate text-ink-muted">
                          <span className="text-success">{t.corrected(1).replace("1 ", "")}</span> · &quot;{result.repeatedText}&quot; · {formatTimecode(result.repeatedStartMs, true)}
                        </span>
                        <button onClick={() => undoOne(result)} className="shrink-0 text-ink-muted underline underline-offset-2 hover:text-ink">
                          {t.undo}
                        </button>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <TranscriptView
                t={t}
                loading={transcriptLoading}
                error={transcriptError}
                lines={transcript}
                resultsById={resultsById}
                canUndo={editHistory.length > 0}
                canRedo={redoStack.length > 0}
                onUndo={undoEdit}
                onRedo={redoEdit}
                onSeek={onSeek}
                onKeep={dismiss}
                onCorrect={(result) => applyOne(result, result.suggestedMode)}
                onSaveLine={saveLineEdit}
              />
            )}
          </div>
        )}
      </div>

      {batchPreview && job && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setBatchPreview(null)}>
          <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-line bg-panel p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-ink">{t.batchTitle}</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
              <dt className="text-ink-muted">{t.batchDetected}</dt>
              <dd className="text-right text-ink">{batchPreview.totalPending}</dd>
              <dt className="text-ink-muted">{t.batchSelected}</dt>
              <dd className="text-right text-ink">{batchPreview.highConfidencePending}</dd>
              <dt className="text-ink-muted">{t.batchDurationRemoved}</dt>
              <dd className="text-right text-ink">{formatTimecode(batchPreview.estimatedDurationRemovedMs, true)}</dd>
            </dl>
            {batchPreview.needsReviewPending > 0 && (
              <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs text-amber-400">{t.batchNeedsReview(batchPreview.needsReviewPending)}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setBatchPreview(null)} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink hover:border-brand/60">
                {t.cancelEdit}
              </button>
              <button
                onClick={confirmBatch}
                disabled={batchApplying}
                className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-ink hover:bg-brand/90 disabled:opacity-50"
              >
                {batchApplying ? t.batchApplying : t.batchConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function LanguageToggle({ value, onChange }: { value: DisplayLang; onChange: (lang: DisplayLang) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line bg-panel p-0.5 text-[11px]">
      {(Object.keys(LANGUAGE_LABELS) as DisplayLang[]).map((lang) => (
        <button
          key={lang}
          onClick={() => onChange(lang)}
          className={`rounded px-1.5 py-1 font-medium transition-colors ${value === lang ? "bg-brand text-ink" : "text-ink-muted hover:text-ink"}`}
        >
          {LANGUAGE_LABELS[lang]}
        </button>
      ))}
    </div>
  );
}

function EmptyStateNotice({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success/15 text-success">✓</span>
      <p className="text-sm text-ink-muted">{message}</p>
    </div>
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
  t,
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
  t: VoiceCorrectionStrings;
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
  const label = confidenceLabel(result.confidenceScore, result.confidenceBucket, t);
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-3.5 text-sm shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <button onClick={onSeek} className="text-xs font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline">
          {kindLabel(result.kind, t)} · {formatTimecode(result.repeatedStartMs, true)}–{formatTimecode(result.repeatedEndMs, true)}
        </button>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${CONFIDENCE_STYLES[result.confidenceBucket]}`}>
          {label} · {Math.round(result.confidenceScore * 100)}%
        </span>
      </div>

      {result.speakerLabel && (
        <p className="text-xs text-ink-muted">
          {t.speaker}: <span className="text-ink">{result.speakerLabel}</span>
        </p>
      )}

      <div className="flex flex-col gap-1 rounded-lg bg-surface/60 p-2.5 text-xs">
        <p className="text-ink-muted">
          {t.original}: <span dir="auto" className="text-ink">&quot;{result.originalText}&quot;</span>
        </p>
        <p className="text-ink-muted">
          {t.repeated}: <span dir="auto" className="text-danger">&quot;{result.repeatedText}&quot;</span>
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
        <button onClick={onPlayBefore} className="flex-1 rounded-md border border-line py-1.5 text-xs text-ink transition-colors hover:border-brand">
          {t.playBefore}
        </button>
        <button onClick={onPlayAfter} className="flex-1 rounded-md border border-line py-1.5 text-xs text-ink transition-colors hover:border-brand">
          {t.playAfter}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={onKeep} className="rounded-md border border-line py-1.5 text-xs text-ink transition-colors hover:border-brand">
          {t.keepOriginal}
        </button>
        <button onClick={onRemove} className="rounded-md bg-danger py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-danger/90">
          {t.removeDuplicate}
        </button>
        <button onClick={onRoomTone} className="rounded-md border border-line py-1.5 text-xs text-ink transition-colors hover:border-brand">
          {t.replaceWithRoomTone}
        </button>
        <button onClick={onTrim} className="flex items-center justify-center gap-1 rounded-md border border-line py-1.5 text-xs text-ink transition-colors hover:border-brand">
          <TrashIcon width={11} height={11} /> {t.trimAudioVideo}
        </button>
      </div>
    </div>
  );
}

// Reconstructs a "corrected script" reading for a flagged WORD/PHRASE
// repeat by joining the contiguous run of lines around it (same clip,
// negligible gaps — the same adjacency splitOnImmediateRepeats.ts used to
// carve the duplicate out of one continuous utterance in the first
// place), skipping the flagged line's own text. For a SENTENCE-level
// repeat the "original" line already reads as the whole corrected
// sentence on its own, so this is skipped — showing it a second time
// would be redundant, not informative.
function buildCorrectedScript(lines: TranscriptLine[], index: number, result: RepetitionResult): string | null {
  if (result.kind === "SENTENCE" || result.kind === "CLIP_OVERLAP" || result.kind === "RENDER_DUPLICATE" || result.kind === "SCENE_JOIN") return null;
  const ADJACENCY_MS = 1200;
  let start = index;
  while (start > 0 && lines[start].clipId === lines[start - 1].clipId && lines[start].startMs - lines[start - 1].endMs <= ADJACENCY_MS) start--;
  let end = index;
  while (end < lines.length - 1 && lines[end].clipId === lines[end + 1].clipId && lines[end + 1].startMs - lines[end].endMs <= ADJACENCY_MS) end++;
  if (start === end) return null;
  const parts = lines.slice(start, end + 1).filter((_, i) => start + i !== index);
  const text = parts.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

function TranscriptView({
  t,
  loading,
  error,
  lines,
  resultsById,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSeek,
  onKeep,
  onCorrect,
  onSaveLine,
}: {
  t: VoiceCorrectionStrings;
  loading: boolean;
  error: string | null;
  lines: TranscriptLine[] | null;
  resultsById: Map<string, RepetitionResult>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSeek: (ms: number) => void;
  onKeep: (result: RepetitionResult) => void;
  onCorrect: (result: RepetitionResult) => void;
  onSaveLine: (line: TranscriptLine, nextText: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (loading) return <p className="text-sm text-ink-muted">{t.loadingTranscript}</p>;
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!lines || lines.length === 0) return <p className="text-sm text-ink-muted">{t.noTranscript}</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel/60 px-2.5 py-1.5">
        <p className="text-[11px] text-ink-muted">{t.editHint}</p>
        <div className="flex shrink-0 gap-1">
          <button onClick={onUndo} disabled={!canUndo} className="rounded-md p-1.5 text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30" title={t.undo}>
            <UndoIcon width={13} height={13} />
          </button>
          <button onClick={onRedo} disabled={!canRedo} className="rounded-md p-1.5 text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30" title={t.applyAllApproved}>
            <RedoIcon width={13} height={13} />
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {lines.map((line, index) => {
          const result = line.repetitionResultId ? resultsById.get(line.repetitionResultId) : undefined;
          const isFlaggedRepeat = line.role === "repeated" && result && result.status === "PENDING";
          const isResolvedRepeat = line.role === "repeated" && result && result.status !== "PENDING";
          const isEditing = editingId === line.id;
          const correctedScript = isFlaggedRepeat ? buildCorrectedScript(lines, index, result) : null;

          return (
            <div key={line.id} className="flex flex-col gap-1">
              {isEditing ? (
                <div className="flex items-start gap-2 rounded-md bg-panel px-2 py-1.5">
                  <span className="shrink-0 pt-1.5 font-mono text-[10px] tabular-nums text-ink-muted">{formatTimecode(line.startMs, true)}</span>
                  <textarea
                    dir="auto"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    className="flex-1 resize-none rounded-md border border-brand bg-surface px-2 py-1 text-sm text-ink outline-none"
                  />
                  <div className="flex shrink-0 flex-col gap-1">
                    <button
                      onClick={() => {
                        onSaveLine(line, draft.trim());
                        setEditingId(null);
                      }}
                      className="rounded bg-brand px-2 py-1 text-[11px] font-medium text-ink hover:bg-brand/90"
                    >
                      {t.save}
                    </button>
                    <button onClick={() => setEditingId(null)} className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:text-ink">
                      {t.cancelEdit}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className={`group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm ${
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
                  <button onClick={() => onSeek(line.startMs)} className="shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-ink-muted hover:text-ink">
                    {formatTimecode(line.startMs, true)}
                  </button>
                  <span dir="auto" className="flex-1 text-left">
                    {line.text}
                    {line.edited && <span className="ml-1.5 text-[10px] font-medium text-brand">●</span>}
                  </span>
                  <button
                    onClick={() => {
                      setEditingId(line.id);
                      setDraft(line.text);
                    }}
                    className="shrink-0 rounded p-1 text-ink-muted opacity-0 hover:text-ink group-hover:opacity-100"
                    title={t.edit}
                  >
                    <PencilIcon width={12} height={12} />
                  </button>
                </div>
              )}

              {isFlaggedRepeat && (
                <div className="ml-2 flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-2 text-xs">
                  <p className="text-ink-muted">{SUGGEST_COPY(result!.suggestedMode, t)}</p>
                  {correctedScript && (
                    <p className="rounded-md bg-surface/70 px-2 py-1.5 text-ink">
                      <span className="text-ink-muted">{t.correctedScript}: </span>
                      <span dir="auto">&quot;{correctedScript}&quot;</span>
                    </p>
                  )}
                  <div className="flex gap-1.5">
                    <button onClick={() => onKeep(result!)} className="flex-1 rounded border border-line py-1 text-ink hover:border-brand">
                      {t.keepOriginal}
                    </button>
                    <button onClick={() => onCorrect(result!)} className="flex-1 rounded bg-danger py-1 font-medium text-ink hover:bg-danger/90">
                      {t.applyFix}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SUGGEST_COPY(mode: CorrectionMode, t: VoiceCorrectionStrings): string {
  return mode === "AUDIO_VIDEO_TRIM" ? t.suggestTrim : t.suggestRoomTone;
}

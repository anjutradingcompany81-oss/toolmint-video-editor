"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { useTimelinePlayer, type ClipLayoutEntry } from "@/lib/use-timeline-player";
import { listMedia, type MediaAsset } from "@/lib/projects-api";
import {
  newVideoClip,
  splitClip,
  removeRangeOnTrack,
  moveClip,
  trimClipOnTrack,
  rippleDeleteClip,
  duplicateClip,
  type MediaClip,
} from "@/lib/composition-api";
import EditorHeader from "./editor-header";
import MediaPanel from "./media-panel";
import PreviewPanel from "./preview-panel";
import TimelinePanel, { MAX_PPS, MIN_PPS } from "./timeline-panel";
import PropertiesPanel from "./properties-panel";
import ExportModal from "./export-modal";
import VoiceCorrectionPanel, { type VoiceMarker } from "./voice-correction-panel";
import LogoPanel from "./logo-panel";
import SubtitlesPanel from "./subtitles-panel";
import VoiceOverPanel from "./voice-over-panel";
import { formatTimecode } from "./format";

const DEFAULT_PIXELS_PER_SECOND = 40;
const MESSAGE_TIMEOUT_MS = 4000;

export interface EditorMessage {
  text: string;
  tone: "info" | "success" | "error";
}

// Non-text inputs (range sliders, checkboxes) shouldn't swallow editor
// shortcuts just because they happen to hold focus — a user who just
// dragged the volume slider or the scrubber should still be able to hit
// Space to play. Only actual text-entry controls get excluded.
const TEXT_ENTRY_INPUT_TYPES = new Set(["text", "search", "email", "password", "number", "tel", "url"]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName === "INPUT") return TEXT_ENTRY_INPUT_TYPES.has((target as HTMLInputElement).type);
  return false;
}

export default function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { status } = useRequireAuth();

  const {
    project,
    trackId,
    clips,
    overlayClips,
    withOverlayClips,
    voiceOverClips,
    placeVoiceOver,
    removeVoiceOver,
    subtitles,
    subtitleStyle,
    updateSubtitles,
    loading,
    loadError,
    saveStatus,
    saveError,
    withClips,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useCompositionEditor(projectId);

  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [exportOpen, setExportOpen] = useState(false);

  // "Cut unwanted middle portion" — an in/out selection independent of clip
  // boundaries, marked on the whole timeline rather than on one clip.
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [markOutMs, setMarkOutMs] = useState<number | null>(null);
  const [razorMode, setRazorMode] = useState(false);
  const [message, setMessage] = useState<EditorMessage | null>(null);
  const [voiceCorrectionOpen, setVoiceCorrectionOpen] = useState(false);
  const [logoOpen, setLogoOpen] = useState(false);
  const [subtitlesOpen, setSubtitlesOpen] = useState(false);
  const [voiceOverOpen, setVoiceOverOpen] = useState(false);
  const [voiceMarkers, setVoiceMarkers] = useState<VoiceMarker[]>([]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    listMedia(projectId)
      .then((data) => {
        if (!cancelled) setMedia(data);
      })
      .finally(() => {
        if (!cancelled) setMediaLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [status, projectId]);

  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  // Same fallback (0 for an unresolved/still-processing asset) every other
  // duration calculation here uses, so cut/split math never disagrees with
  // what's drawn.
  const sourceDurationOfClip = useCallback((clip: MediaClip) => mediaById.get(clip.mediaAssetId)?.durationMs ?? 0, [mediaById]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [message]);

  // Clips already carry their own absolute startMs/durationMs (the v2
  // model) — no need to re-derive position from array order the way the
  // old flat-clip model had to.
  // Sorted by startMs, not left in raw array-insertion order: free timeline
  // placement (moveClip) can leave a clip with an earlier startMs than one
  // that was added to `clips` before it, and useTimelinePlayer's
  // findIndexAt/next-clip-on-ended logic both assume array order IS
  // chronological order (a linear scan and a plain `index + 1`,
  // respectively) — sorting once here, at the single shared source both
  // the player and the timeline UI consume, keeps every downstream
  // consumer correct instead of patching each one separately.
  const layout: ClipLayoutEntry[] = useMemo(() => {
    return clips
      .map((clip) => ({ clip, asset: mediaById.get(clip.mediaAssetId), startMs: clip.startMs, durationMs: clip.durationMs }))
      .sort((a, b) => a.startMs - b.startMs);
  }, [clips, mediaById]);

  // Math.max over every entry, not just the last one post-sort — a clip
  // with a later startMs isn't guaranteed to also have the later *end*
  // once clips can leave gaps or (on a different track) run concurrently.
  const totalDurationMs = layout.reduce((max, e) => Math.max(max, e.startMs + e.durationMs), 0);

  // The render canvas takes its shape from the first video clip's source
  // (see computeDimensions in merge-ffmpeg.util.ts). Mirroring that here
  // means the logo position previewed in the Logo panel is computed against
  // the same frame the export will actually use.
  const canvasWidth = layout[0]?.asset?.width ?? 1920;
  const canvasHeight = layout[0]?.asset?.height ?? 1080;

  const player = useTimelinePlayer(layout, totalDurationMs);
  const activeEntry = useMemo(() => {
    for (const entry of layout) {
      if (player.playheadMs < entry.startMs + entry.durationMs - 1 || entry === layout[layout.length - 1]) return entry;
    }
    return undefined;
  }, [layout, player.playheadMs]);

  const selectedEntry = layout.find((e) => e.clip.id === selectedClipId);

  // Warn before leaving with an unsaved edit still pending.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (saveStatus === "unsaved" || saveStatus === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  const addToTimeline = useCallback(
    (assetId: string) => {
      if (!trackId) return;
      const sourceDurationMs = mediaById.get(assetId)?.durationMs ?? 0;
      withClips((prev) => {
        const endMs = prev.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0);
        return [...prev, newVideoClip(trackId, assetId, endMs, sourceDurationMs)];
      });
    },
    [withClips, trackId, mediaById],
  );

  // Routed through trimClipOnTrack so the clip's durationMs (and, for a
  // start-edge trim, its startMs) are actually recomputed — writing the
  // trim offsets alone left the clip the same length on the timeline and
  // in the export, which is why trimming looked like it did nothing.
  const trimClip = useCallback(
    (clipId: string, trimInMs: number, trimOutMs: number) => {
      const sourceDurationMs = clips.find((c) => c.id === clipId) ? sourceDurationOfClip(clips.find((c) => c.id === clipId)!) : 0;
      if (sourceDurationMs <= 0) {
        setMessage({ text: "This clip's media is still processing — try again in a moment.", tone: "error" });
        return;
      }
      withClips((prev) => trimClipOnTrack(prev, clipId, sourceDurationMs, trimInMs, trimOutMs));
    },
    [withClips, clips, sourceDurationOfClip],
  );

  // Free timeline placement: moves one clip to an absolute position,
  // clamped (in moveClip's own pure logic) to avoid overlapping any other
  // clip on the same track — gaps are allowed and deliberately preserved,
  // unlike every other timeline edit here which repacks to close them.
  const moveClipHandler = useCallback(
    (clipId: string, candidateStartMs: number) => {
      withClips((prev) => moveClip(prev, clipId, candidateStartMs));
    },
    [withClips],
  );

  // Plain delete leaves the gap where the clip was (matching every
  // mainstream editor, and now actually representable since positions are
  // no longer repacked); ripple delete closes it by pulling later clips
  // back. Both were previously the same operation because every edit was
  // force-repacked.
  const deleteClip = useCallback(
    (clipId: string) => {
      withClips((prev) => prev.filter((c) => c.id !== clipId));
      setSelectedClipId((current) => (current === clipId ? null : current));
      setMessage({ text: "Clip deleted. The gap is left in place — use Ripple Delete to close it.", tone: "success" });
    },
    [withClips],
  );

  const rippleDelete = useCallback(
    (clipId: string) => {
      withClips((prev) => rippleDeleteClip(prev, clipId));
      setSelectedClipId((current) => (current === clipId ? null : current));
      setMessage({ text: "Clip removed and the gap closed.", tone: "success" });
    },
    [withClips],
  );

  const duplicateSelected = useCallback(
    (clipId: string) => {
      withClips((prev) => duplicateClip(prev, clipId));
      setMessage({ text: "Clip duplicated.", tone: "success" });
    },
    [withClips],
  );

  const setClipVolume = useCallback(
    (clipId: string, volume: number) => {
      withClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, volume } : c)));
    },
    [withClips],
  );

  const setClipMuted = useCallback(
    (clipId: string, muted: boolean) => {
      withClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, muted } : c)));
    },
    [withClips],
  );

  // Clearing the trims has to go through the same geometry recompute as any
  // other trim, or the clip keeps its trimmed length while claiming to be
  // untrimmed.
  const resetClip = useCallback(
    (clipId: string) => {
      const clip = clips.find((c) => c.id === clipId);
      const sourceDurationMs = clip ? sourceDurationOfClip(clip) : 0;
      withClips((prev) => {
        const restored = sourceDurationMs > 0 ? trimClipOnTrack(prev, clipId, sourceDurationMs, 0, 0) : prev;
        return restored.map((c) => (c.id === clipId ? { ...c, volume: 1, muted: false } : c));
      });
    },
    [withClips, clips, sourceDurationOfClip],
  );

  // Shared by "Split at playhead" (S / the Split button) and razor-mode
  // clicks on the timeline — the only difference is which ms position they
  // pass in.
  const splitAt = useCallback(
    (atMs: number) => {
      const entry = layout.find((e) => atMs > e.startMs && atMs < e.startMs + e.durationMs);
      if (!entry || !entry.asset?.durationMs) {
        setMessage({ text: "Move the playhead inside a clip before splitting.", tone: "error" });
        return;
      }
      const offsetMs = atMs - entry.startMs;
      const result = splitClip(entry.clip, entry.asset.durationMs, offsetMs);
      if (!result) {
        setMessage({ text: "Too close to the edge of this clip to split here.", tone: "error" });
        return;
      }
      const [first, second] = result;
      withClips((prev) => {
        const index = prev.findIndex((c) => c.id === entry.clip.id);
        if (index === -1) return prev;
        const next = [...prev];
        next.splice(index, 1, first, second);
        return next;
      });
      setSelectedClipId(second.id);
    },
    [layout, withClips],
  );

  const splitAtPlayhead = useCallback(() => splitAt(player.playheadMs), [splitAt, player.playheadMs]);
  const canSplit = layout.some((e) => player.playheadMs > e.startMs && player.playheadMs < e.startMs + e.durationMs);

  // Razor/blade tool: while active, clicking the timeline (not a trim
  // handle) splits at that exact point in one gesture instead of
  // seek-then-press-S.
  const handleRazorClick = useCallback(
    (atMs: number) => {
      player.seekTo(atMs);
      splitAt(atMs);
    },
    [player, splitAt],
  );

  // "Cut unwanted middle portion" — In/Out marks are independent of clip
  // boundaries, so validation happens against the whole timeline's current
  // total duration, not any one clip.
  const markIn = useCallback(() => {
    if (totalDurationMs === 0) {
      setMessage({ text: "Add a clip to the timeline first.", tone: "error" });
      return;
    }
    const ms = Math.min(player.playheadMs, totalDurationMs);
    setMarkInMs(ms);
    setMarkOutMs((prevOut) => (prevOut !== null && prevOut <= ms ? null : prevOut));
    setMessage({ text: `Start marked at ${formatTimecode(ms, true)}.`, tone: "info" });
  }, [player.playheadMs, totalDurationMs]);

  const markOut = useCallback(() => {
    if (markInMs === null) {
      setMessage({ text: "Select the beginning and end of the unwanted section.", tone: "error" });
      return;
    }
    const ms = Math.min(player.playheadMs, totalDurationMs);
    if (ms <= markInMs) {
      setMessage({ text: "The end point must be after the start point.", tone: "error" });
      return;
    }
    setMarkOutMs(ms);
    setMessage({ text: `End marked at ${formatTimecode(ms, true)}.`, tone: "info" });
  }, [markInMs, player.playheadMs, totalDurationMs]);

  const clearMarks = useCallback(() => {
    setMarkInMs(null);
    setMarkOutMs(null);
  }, []);

  const hasMarkedRange = markInMs !== null && markOutMs !== null && markOutMs > markInMs;

  // The only delete this data model can represent: clips are always
  // concatenated back-to-back with no absolute positions, so removing a
  // range (or a whole clip) is inherently a ripple delete — there's no
  // gap to leave behind, and so no separate "standard delete" mode exists.
  const cutSelection = useCallback(() => {
    if (markInMs === null || markOutMs === null || markOutMs <= markInMs || !trackId) {
      setMessage({ text: "Select the beginning and end of the unwanted section.", tone: "error" });
      return;
    }
    const durationMs = markOutMs - markInMs;
    const confirmed = window.confirm(
      `Remove the selected section (${formatTimecode(markInMs, true)}–${formatTimecode(markOutMs, true)}, ${formatTimecode(durationMs, true)} long)? The remaining parts will join automatically with no gap.`,
    );
    if (!confirmed) return;

    const result = removeRangeOnTrack(clips, trackId, sourceDurationOfClip, markInMs, markOutMs);
    if (!result.ok) {
      setMessage({ text: result.message, tone: "error" });
      return;
    }
    withClips(() => result.clips);
    setSelectedClipId(null);
    clearMarks();
    player.seekTo(markInMs);
    setMessage({ text: "Selected portion removed successfully. The original video remains unchanged.", tone: "success" });
  }, [markInMs, markOutMs, clips, trackId, sourceDurationOfClip, withClips, clearMarks, player]);

  // Delete / Backspace leaves the gap; Shift+Delete ripples it closed.
  // These are now genuinely different operations — before positions were
  // preserved, both did the same thing because every edit was repacked.
  // A marked range still takes priority over a selected clip.
  const handleDeleteKey = useCallback(
    (ripple: boolean) => {
      if (hasMarkedRange) {
        cutSelection();
      } else if (selectedClipId) {
        if (ripple) rippleDelete(selectedClipId);
        else deleteClip(selectedClipId);
      } else {
        setMessage({ text: "Select a clip, or mark a start and end point, before deleting.", tone: "error" });
      }
    },
    [hasMarkedRange, cutSelection, selectedClipId, deleteClip, rippleDelete],
  );

  // Keyboard shortcuts — see spec: Space, S, I, O, Delete, Shift+Delete,
  // Ctrl/Cmd+Z, Ctrl/Cmd+Y, Ctrl/Cmd+Shift+Z, arrows, Ctrl/Cmd +/-.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        player.togglePlay();
      } else if ((e.key === "s" || e.key === "S") && !mod) {
        splitAtPlayhead();
      } else if ((e.key === "i" || e.key === "I") && !mod) {
        e.preventDefault();
        markIn();
      } else if ((e.key === "o" || e.key === "O") && !mod) {
        e.preventDefault();
        markOut();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDeleteKey(e.shiftKey);
      } else if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        if (selectedClipId) duplicateSelected(selectedClipId);
      } else if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        player.stepFrame(-1, project?.fps ?? 30);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        player.stepFrame(1, project?.fps ?? 30);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setPixelsPerSecond((p) => Math.min(MAX_PPS, p * 1.4));
      } else if (mod && e.key === "-") {
        e.preventDefault();
        setPixelsPerSecond((p) => Math.max(MIN_PPS, p / 1.4));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [player, splitAtPlayhead, markIn, markOut, handleDeleteKey, undo, redo, project?.fps, selectedClipId, duplicateSelected]);

  if (status !== "authenticated" || loading || !mediaLoaded) {
    return <main className="flex min-h-screen items-center justify-center bg-surface text-sm text-ink-muted">Loading…</main>;
  }

  if (loadError || !project) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-surface text-center">
        <p className="text-sm text-danger">{loadError ?? "Something went wrong."}</p>
        <Link href="/dashboard" className="text-sm text-ink-muted underline underline-offset-2">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface">
      {message && (
        <div
          role="status"
          className={`pointer-events-none absolute left-1/2 top-16 z-50 -translate-x-1/2 rounded-md border px-4 py-2 text-sm shadow-lg ${
            message.tone === "error"
              ? "border-danger/40 bg-danger/15 text-danger"
              : message.tone === "success"
                ? "border-success/40 bg-success/15 text-success"
                : "border-line bg-panel text-ink"
          }`}
        >
          {message.text}
        </div>
      )}

      <EditorHeader
        title={project.title}
        saveStatus={saveStatus}
        saveError={saveError}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onExport={() => setExportOpen(true)}
        exportDisabled={clips.length === 0}
        onToggleVoiceCorrection={() => setVoiceCorrectionOpen((v) => !v)}
        voiceCorrectionOpen={voiceCorrectionOpen}
        onToggleLogo={() => setLogoOpen((v) => !v)}
        logoOpen={logoOpen}
        onToggleSubtitles={() => setSubtitlesOpen((v) => !v)}
        subtitlesOpen={subtitlesOpen}
        onToggleVoiceOver={() => setVoiceOverOpen((v) => !v)}
        voiceOverOpen={voiceOverOpen}
      />

      <div className="flex flex-1 overflow-hidden">
        <MediaPanel
          projectId={projectId}
          media={media}
          onMediaAdded={(asset) => setMedia((prev) => [asset, ...prev])}
          onMediaDeleted={(id) => setMedia((prev) => prev.filter((m) => m.id !== id))}
          onAddToTimeline={addToTimeline}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <PreviewPanel
            player={player}
            activeEntry={activeEntry}
            totalDurationMs={totalDurationMs}
            fps={project.fps}
            onSetActiveClipVolume={(volume) => activeEntry && setClipVolume(activeEntry.clip.id, volume)}
            onSetActiveClipMuted={(muted) => activeEntry && setClipMuted(activeEntry.clip.id, muted)}
          />

          <TimelinePanel
            layout={layout}
            totalDurationMs={totalDurationMs}
            playheadMs={player.playheadMs}
            onSeek={player.seekTo}
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            pixelsPerSecond={pixelsPerSecond}
            onZoomChange={setPixelsPerSecond}
            onTrim={trimClip}
            onMoveClip={moveClipHandler}
            onSplit={splitAtPlayhead}
            onDeleteSelected={() => selectedClipId && deleteClip(selectedClipId)}
            onRippleDeleteSelected={() => selectedClipId && rippleDelete(selectedClipId)}
            onDuplicateSelected={() => selectedClipId && duplicateSelected(selectedClipId)}
            splitDisabled={!canSplit}
            markInMs={markInMs}
            markOutMs={markOutMs}
            hasMarkedRange={hasMarkedRange}
            onMarkIn={markIn}
            onMarkOut={markOut}
            onAdjustMarkIn={setMarkInMs}
            onAdjustMarkOut={setMarkOutMs}
            onCutSelection={cutSelection}
            razorMode={razorMode}
            onToggleRazorMode={() => setRazorMode((v) => !v)}
            onRazorClick={handleRazorClick}
            voiceMarkers={voiceMarkers}
          />
        </div>

        <PropertiesPanel
          entry={selectedEntry}
          onSetTrim={(trimInMs, trimOutMs) => selectedClipId && trimClip(selectedClipId, trimInMs, trimOutMs)}
          onSetVolume={(volume) => selectedClipId && setClipVolume(selectedClipId, volume)}
          onSetMuted={(muted) => selectedClipId && setClipMuted(selectedClipId, muted)}
          onReset={() => selectedClipId && resetClip(selectedClipId)}
          onDelete={() => selectedClipId && deleteClip(selectedClipId)}
          onRippleDelete={() => selectedClipId && rippleDelete(selectedClipId)}
          onDuplicate={() => selectedClipId && duplicateSelected(selectedClipId)}
        />

        <LogoPanel
          open={logoOpen}
          onClose={() => setLogoOpen(false)}
          images={media.filter((m) => m.kind === "IMAGE" && m.status === "READY")}
          overlayClips={overlayClips}
          mediaById={mediaById}
          projectWidth={canvasWidth}
          projectHeight={canvasHeight}
          totalDurationMs={totalDurationMs}
          withOverlayClips={withOverlayClips}
        />

        <SubtitlesPanel
          open={subtitlesOpen}
          onClose={() => setSubtitlesOpen(false)}
          projectId={projectId}
          subtitles={subtitles}
          subtitleStyle={subtitleStyle}
          onChange={updateSubtitles}
          onSeek={player.seekTo}
        />

        <VoiceOverPanel
          open={voiceOverOpen}
          onClose={() => setVoiceOverOpen(false)}
          projectId={projectId}
          onSeek={player.seekTo}
          hasVoiceOverOnTimeline={voiceOverClips.length > 0}
          onPlaced={(asset, durationMs) => {
            placeVoiceOver(asset.id, durationMs);
            // The generated track is a real project asset, so it belongs
            // in the media list too - it was created server-side after
            // this page loaded, so nothing else would put it there.
            setMedia((prev) => (prev.some((m) => m.id === asset.id) ? prev : [asset, ...prev]));
          }}
          onRemove={removeVoiceOver}
        />

        <VoiceCorrectionPanel
          open={voiceCorrectionOpen}
          onClose={() => setVoiceCorrectionOpen(false)}
          projectId={projectId}
          trackId={trackId}
          clips={clips}
          selectedClipId={selectedClipId}
          mediaById={mediaById}
          onSeek={player.seekTo}
          withClips={withClips}
          onMarkersChange={setVoiceMarkers}
        />
      </div>

      <ExportModal projectId={projectId} projectTitle={project.title} open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

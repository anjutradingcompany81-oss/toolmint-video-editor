"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { useTimelinePlayer, type ClipLayoutEntry } from "@/lib/use-timeline-player";
import { useAudioPlayback } from "@/lib/use-audio-playback";
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
  positionOverlayClip,
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
import LogoOverlay from "./logo-overlay";
import WatermarkOverlay from "./watermark-overlay";
import WatermarkPanel from "./watermark-panel";
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
    audioClips,
    appendAudioClips,
    removeAudioClip,
    watermarkRemovals,
    updateWatermarkRemovals,
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
  // One panel at a time. These are all absolutely positioned over the same
  // strip on the right, so opening a second used to stack it on top of the
  // first while every button still showed as active — the timeline looked
  // like five tools were running at once. A single value makes opening one
  // close the others, and clicking the same button again closes it.
  type PanelId = "subtitles" | "watermark" | "logo" | "voiceOver" | "voiceCorrection";
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const togglePanel = useCallback((panel: PanelId) => setActivePanel((current) => (current === panel ? null : panel)), []);
  const closePanel = useCallback(() => setActivePanel(null), []);
  const [selectedLogoId, setSelectedLogoId] = useState<string | null>(null);
  const [selectedWatermarkId, setSelectedWatermarkId] = useState<string | null>(null);
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
  // Audio counts towards the timeline length too. Measuring the video
  // track alone made the scrub bar and preview stop early whenever a music
  // or narration track ran past the picture — while the export, which
  // measures every clip, kept going. Preview and export must agree on how
  // long the video is.
  const totalDurationMs = Math.max(
    layout.reduce((max, e) => Math.max(max, e.startMs + e.durationMs), 0),
    audioClips.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0),
    voiceOverClips.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0),
  );

  // The render canvas takes its shape from the first video clip's source
  // (see computeDimensions in merge-ffmpeg.util.ts). Mirroring that here
  // means the logo position previewed in the Logo panel is computed against
  // the same frame the export will actually use.
  const canvasWidth = layout[0]?.asset?.width ?? 1920;
  const canvasHeight = layout[0]?.asset?.height ?? 1080;

  const player = useTimelinePlayer(layout, totalDurationMs);

  // Uploaded audio and the generated voice over now play with the preview.
  // The <video> element only carries its own clip's sound, so anything on
  // an audio track used to be silent until export - leaving no way to
  // judge timing against the picture while editing.
  useAudioPlayback({
    clips: [...audioClips, ...voiceOverClips],
    assetById: mediaById,
    playheadMs: player.playheadMs,
    playing: player.playing,
    playbackRate: player.playbackRate,
  });
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
      const asset = mediaById.get(assetId);
      const sourceDurationMs = asset?.durationMs ?? 0;
      // Audio belongs on the audio track. It used to be added as a
      // video-kind clip on the video track, which the render pipeline then
      // fed to ffmpeg as a picture source — an mp3 has no picture, so the
      // export was broken by the act of adding a music file.
      if (asset?.kind === "AUDIO") {
        appendAudioClips([{ mediaAssetId: assetId, durationMs: sourceDurationMs }]);
        setMessage({ text: `"${asset.originalName}" added to the audio track.`, tone: "success" });
        return;
      }
      withClips((prev) => {
        const endMs = prev.reduce((max, c) => Math.max(max, c.startMs + c.durationMs), 0);
        return [...prev, newVideoClip(trackId, assetId, endMs, sourceDurationMs)];
      });
    },
    [withClips, trackId, mediaById, appendAudioClips],
  );

  // Adds a whole batch of audio files in one action, in the order the panel
  // resolved (numeric by filename). Doing it as one call means one history
  // entry and one save, and — more importantly — the order can't drift the
  // way it does when a user adds nine files by hand.
  const addAudioBatchToTimeline = useCallback(
    (assetIds: string[]) => {
      const items = assetIds
        .map((id) => mediaById.get(id))
        .filter((a): a is NonNullable<typeof a> => Boolean(a) && a!.durationMs != null)
        .map((a) => ({ mediaAssetId: a.id, durationMs: a.durationMs! }));
      if (items.length === 0) {
        setMessage({ text: "Those audio files haven't finished processing yet.", tone: "error" });
        return;
      }
      appendAudioClips(items);
      setMessage({ text: `Added ${items.length} audio file${items.length === 1 ? "" : "s"} to the timeline, in order.`, tone: "success" });
    },
    [mediaById, appendAudioClips],
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
      setMessage({ text: "Clip deleted, gap left in place.", tone: "success" });
    },
    [withClips],
  );

  const rippleDelete = useCallback(
    (clipId: string) => {
      withClips((prev) => rippleDeleteClip(prev, clipId));
      setSelectedClipId((current) => (current === clipId ? null : current));
      setMessage({ text: "Clip deleted and the timeline closed up.", tone: "success" });
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

  // Fades are clamped here as well as in the renderer, so the number the
  // panel shows is the number that will actually be used rather than one
  // quietly corrected later.
  const setClipFades = useCallback(
    (clipId: string, fadeInMs: number, fadeOutMs: number) => {
      withClips((prev) =>
        prev.map((c) => {
          if (c.id !== clipId) return c;
          const inMs = Math.max(0, Math.min(Math.round(fadeInMs), c.durationMs));
          const outMs = Math.max(0, Math.min(Math.round(fadeOutMs), c.durationMs - inMs));
          return { ...c, fadeInMs: inMs, fadeOutMs: outMs };
        }),
      );
    },
    [withClips],
  );

  const setClipMuted = useCallback(
    (clipId: string, muted: boolean) => {
      withClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, muted } : c)));
    },
    [withClips],
  );

  // Dragging a logo on the preview. Goes through withOverlayClips like
  // every other overlay edit, so a drag is undoable (the hook coalesces
  // the burst of pointermove updates into one history entry) and is saved
  // by the same autosave as everything else.
  const moveLogo = useCallback(
    (clipId: string, x: number, y: number, logoSize: { width: number; height: number }) => {
      withOverlayClips((prev) =>
        positionOverlayClip(prev, clipId, x, y, { width: canvasWidth, height: canvasHeight }, logoSize),
      );
    },
    [withOverlayClips, canvasWidth, canvasHeight],
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

  // Cutting a marked range closes only that range: the two halves either
  // side join, and every later clip slides back by exactly the cut length.
  // Gaps elsewhere on the track are deliberate (Delete clip leaves one, a
  // clip can be dragged anywhere) and survive untouched — this used to
  // repack the whole track, which silently dragged footage the user had
  // not touched.
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

  // Delete / Backspace closes the gap; Shift+Delete keeps it. This way
  // round because closing up is what "delete" is expected to do, and the
  // gap-preserving variant is the deliberate, rarer choice.
  // These are now genuinely different operations — before positions were
  // preserved, both did the same thing because every edit was repacked.
  // A marked range still takes priority over a selected clip.
  const handleDeleteKey = useCallback(
    (keepGap: boolean) => {
      if (hasMarkedRange) {
        cutSelection();
      } else if (selectedClipId) {
        if (keepGap) deleteClip(selectedClipId);
        else rippleDelete(selectedClipId);
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
        onToggleVoiceCorrection={() => togglePanel("voiceCorrection")}
        voiceCorrectionOpen={activePanel === "voiceCorrection"}
        onToggleLogo={() => togglePanel("logo")}
        logoOpen={activePanel === "logo"}
        onToggleSubtitles={() => togglePanel("subtitles")}
        subtitlesOpen={activePanel === "subtitles"}
        onToggleVoiceOver={() => togglePanel("voiceOver")}
        voiceOverOpen={activePanel === "voiceOver"}
        onToggleWatermark={() => togglePanel("watermark")}
        watermarkOpen={activePanel === "watermark"}
      />

      <div className="flex flex-1 overflow-hidden">
        <MediaPanel
          projectId={projectId}
          media={media}
          onMediaAdded={(asset) => setMedia((prev) => [asset, ...prev])}
          onMediaDeleted={(id) => setMedia((prev) => prev.filter((m) => m.id !== id))}
          onAddToTimeline={addToTimeline}
          onAddAudioBatch={addAudioBatchToTimeline}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <PreviewPanel
            player={player}
            activeEntry={activeEntry}
            totalDurationMs={totalDurationMs}
            fps={project.fps}
            onSetActiveClipVolume={(volume) => activeEntry && setClipVolume(activeEntry.clip.id, volume)}
            onSetActiveClipMuted={(muted) => activeEntry && setClipMuted(activeEntry.clip.id, muted)}
            overlay={(containerRef) => (
              <>
              <LogoOverlay
                overlayClips={overlayClips}
                mediaById={mediaById}
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                playheadMs={player.playheadMs}
                containerRef={containerRef}
                selectedLogoId={selectedLogoId}
                onSelect={setSelectedLogoId}
                onMove={moveLogo}
              />
              {/* Drawn after the logo layer so a removal box being
                  positioned stays visible on top of an existing logo. */}
              <WatermarkOverlay
                regions={watermarkRemovals}
                canvasWidth={canvasWidth}
                canvasHeight={canvasHeight}
                containerRef={containerRef}
                selectedId={selectedWatermarkId}
                onSelect={setSelectedWatermarkId}
                onChange={updateWatermarkRemovals}
              />
              </>
            )}
          />

          <TimelinePanel
            audioClips={audioClips}
            audioNameOf={(id: string) => mediaById.get(id)?.originalName ?? "Audio"}
            onRemoveAudioClip={removeAudioClip}
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
          onSetFades={(fadeInMs, fadeOutMs) => selectedClipId && setClipFades(selectedClipId, fadeInMs, fadeOutMs)}
          onSetMuted={(muted) => selectedClipId && setClipMuted(selectedClipId, muted)}
          onReset={() => selectedClipId && resetClip(selectedClipId)}
          onDelete={() => selectedClipId && deleteClip(selectedClipId)}
          onRippleDelete={() => selectedClipId && rippleDelete(selectedClipId)}
          onDuplicate={() => selectedClipId && duplicateSelected(selectedClipId)}
        />

        <WatermarkPanel
          open={activePanel === "watermark"}
          onClose={closePanel}
          projectId={projectId}
          regions={watermarkRemovals}
          onChange={updateWatermarkRemovals}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
          playheadMs={player.playheadMs}
          selectedId={selectedWatermarkId}
          onSelect={setSelectedWatermarkId}
          hasClips={clips.length > 0}
        />

        <LogoPanel
          open={activePanel === "logo"}
          onClose={closePanel}
          images={media.filter((m) => m.kind === "IMAGE" && m.status === "READY")}
          overlayClips={overlayClips}
          mediaById={mediaById}
          projectWidth={canvasWidth}
          projectHeight={canvasHeight}
          totalDurationMs={totalDurationMs}
          withOverlayClips={withOverlayClips}
          selectedLogoId={selectedLogoId}
          onSelectLogo={setSelectedLogoId}
        />

        <SubtitlesPanel
          open={activePanel === "subtitles"}
          onClose={closePanel}
          projectId={projectId}
          subtitles={subtitles}
          subtitleStyle={subtitleStyle}
          onChange={updateSubtitles}
          onSeek={player.seekTo}
        />

        <VoiceOverPanel
          open={activePanel === "voiceOver"}
          onClose={closePanel}
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
          open={activePanel === "voiceCorrection"}
          onClose={closePanel}
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

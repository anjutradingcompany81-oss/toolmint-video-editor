"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { useTimelinePlayer, type ClipLayoutEntry } from "@/lib/use-timeline-player";
import { listMedia, type MediaAsset } from "@/lib/projects-api";
import { newClip, splitClip, clipDurationMs } from "@/lib/composition-api";
import EditorHeader from "./editor-header";
import MediaPanel from "./media-panel";
import PreviewPanel from "./preview-panel";
import TimelinePanel from "./timeline-panel";
import PropertiesPanel from "./properties-panel";
import ExportModal from "./export-modal";

const DEFAULT_PIXELS_PER_SECOND = 40;

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

  const { project, clips, loading, loadError, saveStatus, saveError, withClips, undo, redo, canUndo, canRedo } =
    useCompositionEditor(projectId);

  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
  const [exportOpen, setExportOpen] = useState(false);

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

  const layout: ClipLayoutEntry[] = useMemo(() => {
    const entries: ClipLayoutEntry[] = [];
    let cursor = 0;
    for (const clip of clips) {
      const asset = mediaById.get(clip.mediaAssetId);
      const sourceDurationMs = asset?.durationMs ?? 0;
      const durationMs = clipDurationMs(clip, sourceDurationMs);
      entries.push({ clip, asset, startMs: cursor, durationMs });
      cursor += durationMs;
    }
    return entries;
  }, [clips, mediaById]);

  const totalDurationMs = layout.length > 0 ? layout[layout.length - 1].startMs + layout[layout.length - 1].durationMs : 0;

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
      withClips((prev) => [...prev, newClip(assetId)]);
    },
    [withClips],
  );

  const trimClip = useCallback(
    (clipId: string, trimInMs: number, trimOutMs: number) => {
      withClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, trimInMs, trimOutMs } : c)));
    },
    [withClips],
  );

  const reorderClips = useCallback(
    (fromIndex: number, toIndex: number) => {
      withClips((prev) => {
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      });
    },
    [withClips],
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      withClips((prev) => prev.filter((c) => c.id !== clipId));
      setSelectedClipId((current) => (current === clipId ? null : current));
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

  const resetClip = useCallback(
    (clipId: string) => {
      withClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, trimInMs: 0, trimOutMs: 0, volume: 1, muted: false } : c)));
    },
    [withClips],
  );

  const splitAtPlayhead = useCallback(() => {
    const entry = layout.find((e) => player.playheadMs > e.startMs && player.playheadMs < e.startMs + e.durationMs);
    if (!entry || !entry.asset?.durationMs) return;
    const offsetMs = player.playheadMs - entry.startMs;
    const result = splitClip(entry.clip, entry.asset.durationMs, offsetMs);
    if (!result) return;
    const [first, second] = result;
    withClips((prev) => {
      const index = prev.findIndex((c) => c.id === entry.clip.id);
      if (index === -1) return prev;
      const next = [...prev];
      next.splice(index, 1, first, second);
      return next;
    });
    setSelectedClipId(second.id);
  }, [layout, player.playheadMs, withClips]);

  const canSplit = layout.some((e) => player.playheadMs > e.startMs && player.playheadMs < e.startMs + e.durationMs);

  // Keyboard shortcuts — see spec: Space, S, Delete, Ctrl/Cmd+Z,
  // Ctrl/Cmd+Shift+Z, arrows, Ctrl/Cmd +/-.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === "Space" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        player.togglePlay();
      } else if (e.key === "s" || e.key === "S") {
        if (!mod) splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) {
          e.preventDefault();
          deleteClip(selectedClipId);
        }
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
        setPixelsPerSecond((p) => Math.min(300, p * 1.4));
      } else if (mod && e.key === "-") {
        e.preventDefault();
        setPixelsPerSecond((p) => Math.max(10, p / 1.4));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [player, splitAtPlayhead, selectedClipId, deleteClip, undo, redo, project?.fps]);

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
    <div className="flex h-screen flex-col overflow-hidden bg-surface">
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
            onReorder={reorderClips}
            onSplit={splitAtPlayhead}
            onDeleteSelected={() => selectedClipId && deleteClip(selectedClipId)}
            splitDisabled={!canSplit}
          />
        </div>

        <PropertiesPanel
          entry={selectedEntry}
          onSetTrim={(trimInMs, trimOutMs) => selectedClipId && trimClip(selectedClipId, trimInMs, trimOutMs)}
          onSetVolume={(volume) => selectedClipId && setClipVolume(selectedClipId, volume)}
          onSetMuted={(muted) => selectedClipId && setClipMuted(selectedClipId, muted)}
          onReset={() => selectedClipId && resetClip(selectedClipId)}
          onDelete={() => selectedClipId && deleteClip(selectedClipId)}
        />
      </div>

      <ExportModal projectId={projectId} projectTitle={project.title} open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}

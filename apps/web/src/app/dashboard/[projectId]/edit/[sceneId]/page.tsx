"use client";

import { use, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { ApiError } from "@/lib/api-client";
import { listMedia, setProjectThumbnail, type MediaAsset } from "@/lib/projects-api";
import {
  defaultClipDurationMs,
  newTextItem,
  newTimelineItem,
  newTrack,
  overlapWithPreviousMs,
  trackAcceptsMediaKind,
  TRANSITION_TYPE_LABELS,
  type MediaTimelineItem,
  type Scene,
  type TextTimelineItem,
  type Track,
  type TrackType,
  type TransitionType,
} from "@/lib/composition-api";
import SaveIndicator from "@/components/save-indicator";
import { LockIcon, MuteIcon, PlusIcon, RedoIcon, ScissorsIcon, TrackKindIcon, TrashIcon, UndoIcon, UnlockIcon, VolumeIcon } from "@/components/icons";
import MediaLibrary from "./media-library";
import TimelineItemBlock, { type ItemPatch } from "./timeline-item-block";
import ExportPanel from "./export-panel";
import ScenePreview, { type ScenePreviewHandle } from "./scene-preview";

const MIN_PX_PER_SECOND = 20;
const MAX_PX_PER_SECOND = 200;
const DEFAULT_PX_PER_SECOND = 60;
const PLAYHEAD_SNAP_MS = 50;
// Must match the track-row label column: w-32 (128px) + gap-2 (8px). The
// ruler and playhead line sit in a separate DOM subtree from the lanes they
// need to align with, so this offset has to be applied explicitly rather
// than falling out of normal flex layout.
const LABEL_COL_PX = 136;

function trackEndMs(track: Track): number {
  return track.items.reduce((max, item) => Math.max(max, item.startMs + item.durationMs), 0);
}

function sceneEndMs(scene: Scene): number {
  return Math.max(scene.durationMs, ...scene.tracks.map(trackEndMs), 1000);
}

export default function TimelinePage({ params }: { params: Promise<{ projectId: string; sceneId: string }> }) {
  const { projectId, sceneId } = use(params);
  const { status } = useRequireAuth();
  const { project, composition, scenes, loading, loadError, saveStatus, saveError, withScenes, undo, redo, canUndo, canRedo } =
    useCompositionEditor(projectId, status === "authenticated");

  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [armedMediaId, setArmedMediaId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ trackId: string; itemId: string } | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SECOND);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const previewRef = useRef<ScenePreviewHandle>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    listMedia(projectId)
      .then((assets) => {
        if (!cancelled) setMedia(assets);
      })
      .catch((err) => {
        if (!cancelled) setMediaError(err instanceof ApiError ? err.message : "Couldn't load media.");
      });
    return () => {
      cancelled = true;
    };
  }, [status, projectId]);

  // Keyboard shortcuts. Ignored while typing in a form field so hotkeys
  // don't hijack text/number/color inputs elsewhere on the page.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        previewRef.current?.togglePlayPause();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        deleteItem(selected.trackId, selected.itemId);
        return;
      }
      if (e.key.toLowerCase() === "s" && selected) {
        const currentScene = scenes.find((s) => s.id === sceneId);
        const track = currentScene?.tracks.find((t) => t.id === selected.trackId);
        const item = track?.items.find((i) => i.id === selected.itemId);
        if (item && item.type !== "text") splitAtPlayhead(selected.trackId, item);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, selected, playheadMs, sceneId, undo, redo]);

  // Refreshes the project's dashboard thumbnail from whatever the preview
  // canvas currently shows, right after an edit actually saves — not on
  // every keystroke (only real save completions), and not more than once
  // per cooldown window even if saves keep completing back-to-back.
  const prevSaveStatusRef = useRef(saveStatus);
  const lastThumbnailAtRef = useRef(0);
  const THUMBNAIL_COOLDOWN_MS = 20_000;
  useEffect(() => {
    const justSaved = prevSaveStatusRef.current === "saving" && saveStatus === "saved";
    prevSaveStatusRef.current = saveStatus;
    if (!justSaved) return;
    if (Date.now() - lastThumbnailAtRef.current < THUMBNAIL_COOLDOWN_MS) return;
    lastThumbnailAtRef.current = Date.now();

    previewRef.current
      ?.captureFrame()
      .then((blob) => {
        if (blob) return setProjectThumbnail(projectId, blob);
      })
      .catch(() => undefined);
  }, [saveStatus, projectId]);

  const scene = scenes.find((s) => s.id === sceneId);
  const armedMedia = media.find((a) => a.id === armedMediaId) ?? null;

  function msToPx(ms: number): number {
    return (ms / 1000) * pxPerSecond;
  }
  function pxToMs(px: number): number {
    return (px / pxPerSecond) * 1000;
  }

  function updateScene(mutate: (scene: Scene) => Scene) {
    withScenes((prev) => prev.map((s) => (s.id === sceneId ? mutate(s) : s)));
  }

  function updateTrack(trackId: string, mutate: (track: Track) => Track) {
    updateScene((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? mutate(t) : t)) }));
  }

  function addTrack(type: TrackType) {
    updateScene((s) => ({ ...s, tracks: [...s.tracks, newTrack(type)] }));
  }

  function removeTrack(trackId: string) {
    if (!window.confirm("Remove this track and all its clips? This can't be undone.")) return;
    updateScene((s) => ({ ...s, tracks: s.tracks.filter((t) => t.id !== trackId) }));
    setSelected((sel) => (sel?.trackId === trackId ? null : sel));
  }

  function toggleLock(trackId: string) {
    updateTrack(trackId, (t) => ({ ...t, locked: !t.locked }));
  }

  function toggleMute(trackId: string) {
    updateTrack(trackId, (t) => ({ ...t, muted: !t.muted }));
  }

  function appendClip(track: Track) {
    if (!armedMedia || track.locked || !trackAcceptsMediaKind(track.type, armedMedia.kind)) return;
    const startMs = trackEndMs(track);
    const durationMs = defaultClipDurationMs(armedMedia.kind);
    const item = newTimelineItem(armedMedia.id, track.type === "audio" ? "audio" : "clip", startMs, durationMs);
    updateTrack(track.id, (t) => ({ ...t, items: [...t.items, item] }));
  }

  function appendClipAt(track: Track, startMs: number) {
    if (!armedMedia || track.locked || !trackAcceptsMediaKind(track.type, armedMedia.kind)) return;
    const durationMs = defaultClipDurationMs(armedMedia.kind);
    const item = newTimelineItem(armedMedia.id, track.type === "audio" ? "audio" : "clip", Math.max(0, startMs), durationMs);
    updateTrack(track.id, (t) => ({ ...t, items: [...t.items, item] }));
    setSelected({ trackId: track.id, itemId: item.id });
  }

  function appendText(track: Track) {
    if (track.locked) return;
    const item = newTextItem(trackEndMs(track));
    updateTrack(track.id, (t) => ({ ...t, items: [...t.items, item] }));
    setSelected({ trackId: track.id, itemId: item.id });
  }

  function updateItem(trackId: string, itemId: string, patch: ItemPatch) {
    updateTrack(trackId, (t) => ({ ...t, items: t.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }));
  }

  function updateTextItem(trackId: string, itemId: string, patch: Partial<Pick<TextTimelineItem, "content" | "fontSize" | "color">>) {
    updateTrack(trackId, (t) => ({
      ...t,
      items: t.items.map((i) => (i.id === itemId && i.type === "text" ? { ...i, ...patch } : i)),
    }));
  }

  function updateTransitionIn(trackId: string, itemId: string, transitionIn: TransitionType) {
    updateTrack(trackId, (t) => ({
      ...t,
      items: t.items.map((i) => (i.id === itemId && i.type !== "text" ? { ...i, transitionIn } : i)),
    }));
  }

  function deleteItem(trackId: string, itemId: string) {
    // Matches the confirm-before-delete pattern used for projects/scenes/media
    // elsewhere in this app — there's no undo yet, so this is the only
    // guard against an accidental click losing a placed clip.
    if (!window.confirm("Delete this item from the timeline?")) return;
    updateTrack(trackId, (t) => ({ ...t, items: t.items.filter((i) => i.id !== itemId) }));
    setSelected(null);
  }

  function splitAtPlayhead(trackId: string, item: MediaTimelineItem) {
    if (playheadMs <= item.startMs || playheadMs >= item.startMs + item.durationMs) return;
    const leftDuration = playheadMs - item.startMs;
    const rightDuration = item.startMs + item.durationMs - playheadMs;
    const left: MediaTimelineItem = { ...item, durationMs: leftDuration, trimOutMs: item.trimOutMs + rightDuration };
    const right: MediaTimelineItem = {
      ...item,
      id: `${item.id}_split_${Math.random().toString(36).slice(2, 8)}`,
      startMs: playheadMs,
      durationMs: rightDuration,
      trimInMs: item.trimInMs + leftDuration,
    };
    updateTrack(trackId, (t) => ({ ...t, items: t.items.flatMap((i) => (i.id === item.id ? [left, right] : [i])) }));
    setSelected(null);
  }

  function handleRulerClick(e: MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const rawMs = pxToMs(x);
    setPlayheadMs(Math.max(0, Math.round(rawMs / PLAYHEAD_SNAP_MS) * PLAYHEAD_SNAP_MS));
  }

  function handleLaneDrop(e: DragEvent<HTMLDivElement>, track: Track) {
    e.preventDefault();
    setDragOverTrackId(null);
    const rect = e.currentTarget.getBoundingClientRect();
    const rawMs = pxToMs(e.clientX - rect.left);
    const startMs = Math.max(0, Math.round(rawMs / PLAYHEAD_SNAP_MS) * PLAYHEAD_SNAP_MS);
    appendClipAt(track, startMs);
  }

  function handleLaneDragOver(e: DragEvent<HTMLDivElement>, track: Track) {
    if (!armedMedia || track.locked || !trackAcceptsMediaKind(track.type, armedMedia.kind)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (dragOverTrackId !== track.id) setDragOverTrackId(track.id);
  }

  if (status !== "authenticated" || loading) {
    return <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-[var(--tm-text-dim)]">Loading…</main>;
  }

  if (loadError || !project || !composition) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-sm text-red-400">{loadError ?? "Something went wrong."}</p>
        <Link href={`/dashboard/${projectId}/edit`} className="mt-4 inline-block text-sm underline underline-offset-2">
          Back to storyboard
        </Link>
      </main>
    );
  }

  if (!scene) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-sm text-red-400">This scene no longer exists.</p>
        <Link href={`/dashboard/${projectId}/edit`} className="mt-4 inline-block text-sm underline underline-offset-2">
          Back to storyboard
        </Link>
      </main>
    );
  }

  const endMs = sceneEndMs(scene);
  const selectedItem = selected ? scene.tracks.find((t) => t.id === selected.trackId)?.items.find((i) => i.id === selected.itemId) : undefined;
  const selectedTrack = selected ? scene.tracks.find((t) => t.id === selected.trackId) : undefined;
  const selectedItemOverlapMs =
    selectedTrack && selectedItem
      ? overlapWithPreviousMs(
          [...selectedTrack.items].sort((a, b) => a.startMs - b.startMs),
          [...selectedTrack.items].sort((a, b) => a.startMs - b.startMs).findIndex((i) => i.id === selectedItem.id),
        )
      : 0;

  return (
    <main className="mx-auto max-w-[1400px] px-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/dashboard/${projectId}/edit`} className="text-sm text-[var(--tm-text-dim)] underline underline-offset-2">
            ← Storyboard
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{scene.name}</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--tm-line)] text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)] disabled:opacity-30 disabled:hover:border-[var(--tm-line)]"
            >
              <UndoIcon />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--tm-line)] text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)] disabled:opacity-30 disabled:hover:border-[var(--tm-line)]"
            >
              <RedoIcon />
            </button>
          </div>
          <SaveIndicator status={saveStatus} error={saveError} />
        </div>
      </div>

      {/* Three-pane row: media bin | preview | inspector — the classic NLE layout */}
      <div className="mt-6 grid grid-cols-[240px_1fr_260px] gap-4">
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Media</h2>
            <p className="mt-1 text-[11px] text-[var(--tm-text-dim)]">Drag a clip onto a track below — or click one, then click a track.</p>
            {mediaError && <p className="mt-2 text-xs text-red-400">{mediaError}</p>}
            <div className="mt-2">
              <MediaLibrary
                assets={media}
                armedId={armedMediaId}
                onArm={(a) => setArmedMediaId(a.id === armedMediaId ? null : a.id)}
                onDragArm={(a) => setArmedMediaId(a.id)}
              />
            </div>
          </div>

          <div>
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Add track</h2>
            <div className="mt-2 flex flex-col gap-1.5">
              <button
                onClick={() => addTrack("video")}
                className="flex items-center gap-2 rounded-md border border-dashed border-[var(--tm-line)] px-3 py-1.5 text-left text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
              >
                <PlusIcon /> Video track
              </button>
              <button
                onClick={() => addTrack("audio")}
                className="flex items-center gap-2 rounded-md border border-dashed border-[var(--tm-line)] px-3 py-1.5 text-left text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
              >
                <PlusIcon /> Audio track
              </button>
              <button
                onClick={() => addTrack("text")}
                className="flex items-center gap-2 rounded-md border border-dashed border-[var(--tm-line)] px-3 py-1.5 text-left text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
              >
                <PlusIcon /> Text track
              </button>
            </div>
          </div>

          <ExportPanel projectId={projectId} sceneId={sceneId} />
        </div>

        <div className="min-w-0 flex justify-center">
          <ScenePreview
            ref={previewRef}
            scene={scene}
            media={media}
            aspectRatio={project.aspectRatio}
            customWidth={project.customWidth}
            customHeight={project.customHeight}
            endMs={endMs}
            playheadMs={playheadMs}
            onPlayheadChange={setPlayheadMs}
          />
        </div>

        <div className="rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3 text-xs">
          <h2 className="font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">
            {selectedItem ? `Selected ${selectedItem.type === "text" ? "text" : "clip"}` : "Properties"}
          </h2>

          {!selectedItem && (
            <p className="mt-2 text-[11px] text-[var(--tm-text-dim)]">
              Select a clip on the timeline to edit its timing and effects, or drag media from the left onto a track to add one.
            </p>
          )}

          {selectedItem && selectedTrack && (
            <div className="mt-3 flex flex-col gap-2">
              {selectedItem.type === "text" && (
                <>
                  <label className="flex flex-col gap-1">
                    Text
                    <textarea
                      rows={2}
                      className="rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
                      value={selectedItem.content}
                      onChange={(e) => {
                        if (e.target.value.length > 0 && e.target.value.length <= 500) {
                          updateTextItem(selectedTrack.id, selectedItem.id, { content: e.target.value });
                        }
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    Font size (px)
                    <input
                      type="number"
                      min="8"
                      max="300"
                      className="w-20 rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
                      value={selectedItem.fontSize}
                      onChange={(e) => {
                        const size = Number(e.target.value);
                        if (Number.isFinite(size) && size >= 8 && size <= 300) {
                          updateTextItem(selectedTrack.id, selectedItem.id, { fontSize: Math.round(size) });
                        }
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    Color
                    <input
                      type="color"
                      className="h-7 w-14 rounded border border-[var(--tm-line)] bg-[var(--tm-bg)]"
                      value={selectedItem.color}
                      onChange={(e) => updateTextItem(selectedTrack.id, selectedItem.id, { color: e.target.value })}
                    />
                  </label>
                </>
              )}

              <label className="flex items-center justify-between gap-2">
                Start (s)
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  className="w-20 rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
                  value={selectedItem.startMs / 1000}
                  onChange={(e) => {
                    const seconds = Number(e.target.value);
                    if (Number.isFinite(seconds) && seconds >= 0) {
                      updateItem(selectedTrack.id, selectedItem.id, { startMs: Math.round(seconds * 1000) });
                    }
                  }}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                Duration (s)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="w-20 rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
                  value={selectedItem.durationMs / 1000}
                  onChange={(e) => {
                    const seconds = Number(e.target.value);
                    if (Number.isFinite(seconds) && seconds > 0) {
                      updateItem(selectedTrack.id, selectedItem.id, { durationMs: Math.round(seconds * 1000) });
                    }
                  }}
                />
              </label>
              {selectedItem.type !== "text" && (
                <label className="flex items-center justify-between gap-2">
                  Transition in
                  <select
                    className="rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
                    value={selectedItem.transitionIn}
                    onChange={(e) => updateTransitionIn(selectedTrack.id, selectedItem.id, e.target.value as TransitionType)}
                  >
                    {Object.entries(TRANSITION_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selectedItem.type !== "text" && (
                <p className="text-[11px] text-[var(--tm-text-dim)]">
                  {selectedItemOverlapMs > 0
                    ? `Crossfades with the previous clip over the ${(selectedItemOverlapMs / 1000).toFixed(1)}s they overlap.`
                    : "No transition — this clip doesn't overlap the previous one. Drag its left edge over the previous clip to create a crossfade."}
                </p>
              )}
              <div className="mt-1 flex gap-2">
                {selectedItem.type !== "text" && (
                  <button
                    onClick={() => splitAtPlayhead(selectedTrack.id, selectedItem)}
                    disabled={playheadMs <= selectedItem.startMs || playheadMs >= selectedItem.startMs + selectedItem.durationMs}
                    className="flex items-center gap-1.5 rounded-md border border-[var(--tm-line)] px-3 py-1.5 hover:border-[var(--tm-accent)] disabled:opacity-40"
                  >
                    <ScissorsIcon /> Split
                  </button>
                )}
                <button
                  onClick={() => deleteItem(selectedTrack.id, selectedItem.id)}
                  className="flex items-center gap-1.5 rounded-md border border-[var(--tm-line)] px-3 py-1.5 text-red-400 hover:border-red-400"
                >
                  <TrashIcon /> Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Timeline spans the full width, under all three panes above — matches
          how every mainstream NLE lays this out. */}
      <div className="mt-4 flex items-center justify-between text-xs text-[var(--tm-text-dim)]">
        <span title="Space: play/pause · Ctrl+Z: undo · Ctrl+Shift+Z: redo · Delete: remove selected · S: split at playhead">
          Playhead: <span className="font-mono tabular-nums">{(playheadMs / 1000).toFixed(2)}s</span> · click the ruler to move it, drag a clip
          to reposition or trim it · <span className="underline decoration-dotted">keyboard shortcuts</span>
        </span>
        <label className="flex items-center gap-2">
          Zoom
          <input
            type="range"
            min={MIN_PX_PER_SECOND}
            max={MAX_PX_PER_SECOND}
            value={pxPerSecond}
            onChange={(e) => setPxPerSecond(Number(e.target.value))}
            className="accent-[var(--tm-accent)]"
          />
        </label>
      </div>

      <div className="mt-2 overflow-x-auto rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3">
        <div style={{ width: Math.max(msToPx(endMs) + 40, 400) + LABEL_COL_PX }}>
          <div className="flex gap-2">
            <div className="w-32 shrink-0" />
            <div
              onClick={handleRulerClick}
              className="relative h-6 cursor-pointer border-b border-[var(--tm-line)] text-[10px] text-[var(--tm-text-dim)]"
              style={{ width: Math.max(msToPx(endMs), 300) }}
            >
              {Array.from({ length: Math.ceil(endMs / 1000) + 1 }, (_, s) => (
                <span key={s} className="absolute top-0" style={{ left: msToPx(s * 1000) }}>
                  {s}s
                </span>
              ))}
            </div>
          </div>

          <div className="relative mt-2 flex flex-col gap-2">
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-[var(--tm-accent)]"
              style={{ left: LABEL_COL_PX + msToPx(playheadMs) }}
            />

            {scene.tracks.length === 0 && (
              <p className="py-6 text-center text-xs text-[var(--tm-text-dim)]">No tracks yet — add one on the left.</p>
            )}

            {scene.tracks.map((track) => {
              const isTextTrack = track.type === "text";
              const canDrop = !isTextTrack && Boolean(armedMedia) && !track.locked && trackAcceptsMediaKind(track.type, armedMedia?.kind ?? "");
              const canAddText = isTextTrack && !track.locked;
              const canAct = canDrop || canAddText;
              return (
                <div key={track.id} className="flex items-stretch gap-2">
                  <div className="flex w-32 shrink-0 flex-col justify-center gap-1.5 text-[10px] text-[var(--tm-text-dim)]">
                    <span className="flex items-center gap-1.5 uppercase tracking-wide">
                      <TrackKindIcon kind={track.type === "audio" ? "audio" : track.type === "text" ? "text" : "video"} />
                      {track.type}
                    </span>
                    <div className="flex gap-2.5">
                      <button
                        onClick={() => toggleLock(track.id)}
                        title={track.locked ? "Locked — click to unlock" : "Click to lock"}
                        className={track.locked ? "text-[var(--tm-accent)]" : "hover:text-[var(--tm-text)]"}
                      >
                        {track.locked ? <LockIcon /> : <UnlockIcon />}
                      </button>
                      {track.type !== "text" && (
                        <button
                          onClick={() => toggleMute(track.id)}
                          title={track.muted ? "Muted — click to unmute" : "Click to mute"}
                          className={track.muted ? "text-[var(--tm-accent)]" : "hover:text-[var(--tm-text)]"}
                        >
                          {track.muted ? <MuteIcon /> : <VolumeIcon />}
                        </button>
                      )}
                      <button onClick={() => removeTrack(track.id)} title="Remove track" className="text-red-400 hover:text-red-300">
                        <TrashIcon />
                      </button>
                    </div>
                  </div>

                  <div
                    onClick={() => {
                      if (canDrop) appendClip(track);
                      else if (canAddText) appendText(track);
                    }}
                    onDragOver={(e) => handleLaneDragOver(e, track)}
                    onDragLeave={() => setDragOverTrackId((id) => (id === track.id ? null : id))}
                    onDrop={(e) => handleLaneDrop(e, track)}
                    role="button"
                    tabIndex={canAct ? 0 : -1}
                    onKeyDown={(e) => {
                      if (!canAct || (e.key !== "Enter" && e.key !== " ")) return;
                      if (canDrop) appendClip(track);
                      else appendText(track);
                    }}
                    className={`relative h-10 flex-1 rounded border border-dashed bg-[var(--tm-bg)] ${
                      dragOverTrackId === track.id ? "border-[var(--tm-accent)] bg-[var(--tm-accent)]/10" : "border-[var(--tm-line)]"
                    } ${canAct ? "cursor-pointer" : "cursor-default"}`}
                    style={{ width: Math.max(msToPx(endMs), 300) }}
                    title={
                      isTextTrack
                        ? track.locked
                          ? "This track is locked"
                          : "Click to add a text item"
                        : armedMedia
                          ? canDrop
                            ? "Drop or click to add selected media here"
                            : "This track can't accept that media type"
                          : "Select media on the left first"
                    }
                  >
                    {track.items.map((item) => (
                      <TimelineItemBlock
                        key={item.id}
                        item={item}
                        media={item.type === "text" ? undefined : media.find((a) => a.id === item.mediaAssetId)}
                        pxPerSecond={pxPerSecond}
                        selected={selected?.itemId === item.id}
                        locked={track.locked}
                        onSelect={() => setSelected({ trackId: track.id, itemId: item.id })}
                        onUpdate={(patch) => updateItem(track.id, item.id, patch)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </main>
  );
}

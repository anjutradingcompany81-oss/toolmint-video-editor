"use client";

import { use, useEffect, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { ApiError } from "@/lib/api-client";
import { listMedia, type MediaAsset } from "@/lib/projects-api";
import {
  defaultClipDurationMs,
  newTimelineItem,
  newTrack,
  trackAcceptsMediaKind,
  type Scene,
  type TimelineItem,
  type Track,
  type TrackType,
} from "@/lib/composition-api";
import SaveIndicator from "@/components/save-indicator";
import MediaLibrary from "./media-library";
import TimelineItemBlock from "./timeline-item-block";

const PX_PER_SECOND = 60;
const PLAYHEAD_SNAP_MS = 50;
// Must match the track-row label column: w-32 (128px) + gap-2 (8px). The
// ruler and playhead line sit in a separate DOM subtree from the lanes they
// need to align with, so this offset has to be applied explicitly rather
// than falling out of normal flex layout.
const LABEL_COL_PX = 136;

function msToPx(ms: number): number {
  return (ms / 1000) * PX_PER_SECOND;
}

function trackEndMs(track: Track): number {
  return track.items.reduce((max, item) => Math.max(max, item.startMs + item.durationMs), 0);
}

function sceneEndMs(scene: Scene): number {
  return Math.max(scene.durationMs, ...scene.tracks.map(trackEndMs), 1000);
}

export default function TimelinePage({ params }: { params: Promise<{ projectId: string; sceneId: string }> }) {
  const { projectId, sceneId } = use(params);
  const { status } = useRequireAuth();
  const { project, composition, scenes, loading, loadError, saveStatus, saveError, withScenes } = useCompositionEditor(
    projectId,
    status === "authenticated",
  );

  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [armedMediaId, setArmedMediaId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ trackId: string; itemId: string } | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);

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

  const scene = scenes.find((s) => s.id === sceneId);
  const armedMedia = media.find((a) => a.id === armedMediaId) ?? null;

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

  function updateItem(trackId: string, itemId: string, patch: Partial<Pick<TimelineItem, "startMs" | "durationMs">>) {
    updateTrack(trackId, (t) => ({ ...t, items: t.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) }));
  }

  function deleteItem(trackId: string, itemId: string) {
    // Matches the confirm-before-delete pattern used for projects/scenes/media
    // elsewhere in this app — there's no undo yet, so this is the only
    // guard against an accidental click losing a placed clip.
    if (!window.confirm("Delete this clip from the timeline?")) return;
    updateTrack(trackId, (t) => ({ ...t, items: t.items.filter((i) => i.id !== itemId) }));
    setSelected(null);
  }

  function splitAtPlayhead(trackId: string, item: TimelineItem) {
    if (playheadMs <= item.startMs || playheadMs >= item.startMs + item.durationMs) return;
    const leftDuration = playheadMs - item.startMs;
    const rightDuration = item.startMs + item.durationMs - playheadMs;
    const left: TimelineItem = { ...item, durationMs: leftDuration, trimOutMs: item.trimOutMs + rightDuration };
    const right: TimelineItem = {
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
    const rawMs = (x / PX_PER_SECOND) * 1000;
    setPlayheadMs(Math.max(0, Math.round(rawMs / PLAYHEAD_SNAP_MS) * PLAYHEAD_SNAP_MS));
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

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/dashboard/${projectId}/edit`} className="text-sm text-[var(--tm-text-dim)] underline underline-offset-2">
            ← Storyboard
          </Link>
          <h1 className="mt-1 text-xl font-semibold">{scene.name}</h1>
        </div>
        <SaveIndicator status={saveStatus} error={saveError} />
      </div>

      <div className="mt-6 grid grid-cols-[220px_1fr] gap-6">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Media library</h2>
          <p className="mt-1 text-[11px] text-[var(--tm-text-dim)]">Click to select, then click a track to add it there.</p>
          {mediaError && <p className="mt-2 text-xs text-red-400">{mediaError}</p>}
          <div className="mt-2">
            <MediaLibrary assets={media} armedId={armedMediaId} onArm={(a) => setArmedMediaId(a.id === armedMediaId ? null : a.id)} />
          </div>

          <div className="mt-6 flex flex-col gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Tracks</h2>
            <button
              onClick={() => addTrack("video")}
              className="rounded-md border border-dashed border-[var(--tm-line)] px-3 py-1.5 text-left text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
            >
              + Video track
            </button>
            <button
              onClick={() => addTrack("audio")}
              className="rounded-md border border-dashed border-[var(--tm-line)] px-3 py-1.5 text-left text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
            >
              + Audio track
            </button>
          </div>

          {selectedItem && selectedTrack && (
            <div className="mt-6 flex flex-col gap-2 rounded-md border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3 text-xs">
              <h2 className="font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Selected clip</h2>
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
              <button
                onClick={() => splitAtPlayhead(selectedTrack.id, selectedItem)}
                disabled={playheadMs <= selectedItem.startMs || playheadMs >= selectedItem.startMs + selectedItem.durationMs}
                className="rounded-md border border-[var(--tm-line)] px-3 py-1.5 hover:border-[var(--tm-accent)] disabled:opacity-40"
              >
                Split at playhead
              </button>
              <button
                onClick={() => deleteItem(selectedTrack.id, selectedItem.id)}
                className="rounded-md border border-[var(--tm-line)] px-3 py-1.5 text-red-400 hover:border-red-400"
              >
                Delete clip
              </button>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="overflow-x-auto rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3">
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
                  const canDrop = Boolean(armedMedia) && !track.locked && trackAcceptsMediaKind(track.type, armedMedia?.kind ?? "");
                  return (
                    <div key={track.id} className="flex items-stretch gap-2">
                      <div className="flex w-32 shrink-0 flex-col justify-center gap-1 text-[10px] text-[var(--tm-text-dim)]">
                        <span className="uppercase tracking-wide">{track.type}</span>
                        <div className="flex gap-2">
                          <button onClick={() => toggleLock(track.id)} className={track.locked ? "text-[var(--tm-accent)]" : "hover:text-[var(--tm-text)]"}>
                            {track.locked ? "Locked" : "Lock"}
                          </button>
                          <button onClick={() => toggleMute(track.id)} className={track.muted ? "text-[var(--tm-accent)]" : "hover:text-[var(--tm-text)]"}>
                            {track.muted ? "Muted" : "Mute"}
                          </button>
                          <button onClick={() => removeTrack(track.id)} className="text-red-400 hover:text-red-300">
                            Remove
                          </button>
                        </div>
                      </div>

                      <div
                        onClick={() => canDrop && appendClip(track)}
                        role="button"
                        tabIndex={canDrop ? 0 : -1}
                        onKeyDown={(e) => {
                          if (canDrop && (e.key === "Enter" || e.key === " ")) appendClip(track);
                        }}
                        className={`relative h-10 flex-1 rounded border border-dashed border-[var(--tm-line)] bg-[var(--tm-bg)] ${canDrop ? "cursor-pointer" : "cursor-default"}`}
                        style={{ width: Math.max(msToPx(endMs), 300) }}
                        title={armedMedia ? (canDrop ? "Add selected media here" : "This track can't accept that media type") : "Select media on the left first"}
                      >
                        {track.items.map((item) => (
                          <TimelineItemBlock
                            key={item.id}
                            item={item}
                            media={media.find((a) => a.id === item.mediaAssetId)}
                            pxPerSecond={PX_PER_SECOND}
                            selected={selected?.itemId === item.id}
                            onSelect={() => setSelected({ trackId: track.id, itemId: item.id })}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-[var(--tm-text-dim)]">
            Playhead: {(playheadMs / 1000).toFixed(2)}s · click the ruler to move it, click a track lane to append the selected media.
          </p>
        </div>
      </div>
    </main>
  );
}

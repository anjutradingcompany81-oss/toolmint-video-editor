"use client";

import { useRef } from "react";
import type { ClipLayoutEntry } from "@/lib/use-timeline-player";
import MediaThumb from "./media-thumb";
import Waveform from "./waveform";
import { MIN_CLIP_DURATION_MS } from "@/lib/composition-api";
import { formatTimecode } from "./format";

const SNAP_PX = 8;

// Below this many px of pointer movement, a press-and-release on the
// clip body is treated as a click (select), not a move-drag — without a
// threshold, every plain click would jitter the clip by a pixel or two
// before onSelect ever fires.
const MOVE_THRESHOLD_PX = 4;

interface TimelineClipBlockProps {
  entry: ClipLayoutEntry;
  pixelsPerSecond: number;
  selected: boolean;
  snapPoints: number[];
  onSelect: () => void;
  onTrim: (edge: "start" | "end", trimInMs: number, trimOutMs: number) => void;
  // Free timeline placement: reports a live candidate startMs on every
  // pointer-move frame of a drag (already snapped to nearby edges here,
  // but NOT yet collision-clamped — the caller owns that, since avoiding
  // an overlap requires knowing every other clip on the track, not just
  // this block's own snap points).
  onMove: (clipId: string, candidateStartMs: number) => void;
}

export default function TimelineClipBlock({
  entry,
  pixelsPerSecond,
  selected,
  snapPoints,
  onSelect,
  onTrim,
  onMove,
}: TimelineClipBlockProps) {
  const dragInfo = useRef<{ edge: "start" | "end"; startClientX: number; trimInMs: number; trimOutMs: number } | null>(null);
  const moveInfo = useRef<{ startClientX: number; originStartMs: number; moved: boolean } | null>(null);
  const pxPerMs = pixelsPerSecond / 1000;
  const widthPx = Math.max(6, (entry.durationMs / 1000) * pixelsPerSecond);
  const sourceDurationMs = entry.asset?.durationMs ?? entry.durationMs + entry.clip.trimInMs + entry.clip.trimOutMs;

  function snap(candidateMs: number): number {
    const thresholdMs = SNAP_PX / pxPerMs;
    for (const point of snapPoints) {
      if (Math.abs(candidateMs - point) <= thresholdMs) return point;
    }
    return candidateMs;
  }

  function handleBodyPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    moveInfo.current = { startClientX: e.clientX, originStartMs: entry.startMs, moved: false };
  }
  function handleBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const info = moveInfo.current;
    if (!info) return;
    const deltaPx = e.clientX - info.startClientX;
    if (!info.moved && Math.abs(deltaPx) < MOVE_THRESHOLD_PX) return;
    info.moved = true;
    const candidateMs = Math.max(0, info.originStartMs + deltaPx / pxPerMs);
    onMove(entry.clip.id, snap(candidateMs));
  }
  function handleBodyPointerUp() {
    if (!moveInfo.current?.moved) onSelect();
    moveInfo.current = null;
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.preventDefault();
    const edge = e.currentTarget.dataset.edge as "start" | "end";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragInfo.current = { edge, startClientX: e.clientX, trimInMs: entry.clip.trimInMs, trimOutMs: entry.clip.trimOutMs };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const info = dragInfo.current;
    if (!info) return;
    const deltaMs = (e.clientX - info.startClientX) / pxPerMs;

    if (info.edge === "start") {
      const maxTrimIn = sourceDurationMs - info.trimOutMs - MIN_CLIP_DURATION_MS;
      const boundaryMs = entry.startMs - info.trimInMs; // timeline position of the clip's current start
      const rawTrimIn = Math.min(maxTrimIn, Math.max(0, info.trimInMs + deltaMs));
      const snappedBoundary = snap(boundaryMs + (rawTrimIn - info.trimInMs));
      const trimInMs = Math.min(maxTrimIn, Math.max(0, info.trimInMs + (snappedBoundary - boundaryMs)));
      onTrim("start", trimInMs, entry.clip.trimOutMs);
    } else {
      const maxTrimOut = sourceDurationMs - info.trimInMs - MIN_CLIP_DURATION_MS;
      const boundaryMs = entry.startMs + entry.durationMs - info.trimOutMs; // timeline position of the clip's current end
      const rawTrimOut = Math.min(maxTrimOut, Math.max(0, info.trimOutMs - deltaMs));
      const snappedBoundary = snap(boundaryMs - (rawTrimOut - info.trimOutMs));
      const trimOutMs = Math.min(maxTrimOut, Math.max(0, info.trimOutMs - (snappedBoundary - boundaryMs)));
      onTrim("end", entry.clip.trimInMs, trimOutMs);
    }
  }

  function handlePointerUp() {
    dragInfo.current = null;
  }

  return (
    <div
      className={`group absolute flex h-20 shrink-0 select-none flex-col overflow-hidden rounded-md border bg-panel transition-colors ${
        selected ? "border-brand ring-1 ring-brand" : "border-line hover:border-brand/50"
      }`}
      style={{ width: widthPx, left: (entry.startMs / 1000) * pixelsPerSecond }}
    >
      <div
        onPointerDown={handleBodyPointerDown}
        onPointerMove={handleBodyPointerMove}
        onPointerUp={handleBodyPointerUp}
        className="relative flex flex-1 cursor-grab flex-col overflow-hidden active:cursor-grabbing"
        title={entry.asset?.originalName}
      >
        {entry.asset && <MediaThumb asset={entry.asset} className="absolute inset-0 h-full w-full object-cover opacity-60" />}
        <div className="relative z-10 flex items-center justify-between bg-gradient-to-b from-panel/90 to-transparent px-1.5 py-1">
          <span className="truncate text-[11px] font-medium text-ink">{entry.asset?.originalName ?? "…"}</span>
        </div>
        {entry.asset?.waveformPeaks && entry.asset.waveformPeaks.length > 0 && (
          <Waveform
            peaks={entry.asset.waveformPeaks}
            sourceDurationMs={entry.asset.durationMs}
            trimInMs={entry.clip.trimInMs}
            durationMs={entry.durationMs}
            className="absolute bottom-0 left-0 right-0 z-10 h-6 text-brand"
          />
        )}
        <span className="relative z-10 mt-auto px-1.5 pb-1 text-[10px] tabular-nums text-ink-muted">{formatTimecode(entry.durationMs)}</span>
        {entry.clip.muted && (
          <span className="absolute right-1 top-1 z-10 rounded bg-danger/80 px-1 text-[9px] font-medium text-ink">MUTED</span>
        )}
      </div>

      {/* Trim handles — separate from the draggable body above so a trim
          drag never triggers the native HTML5 reorder-drag. */}
      <div
        data-edge="start"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="Drag to trim clip start"
        className="absolute inset-y-0 left-0 z-20 w-2.5 cursor-ew-resize bg-brand/0 hover:bg-brand/70 active:bg-brand"
      />
      <div
        data-edge="end"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        title="Drag to trim clip end"
        className="absolute inset-y-0 right-0 z-20 w-2.5 cursor-ew-resize bg-brand/0 hover:bg-brand/70 active:bg-brand"
      />
    </div>
  );
}

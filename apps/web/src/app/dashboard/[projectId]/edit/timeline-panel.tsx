"use client";

import { useMemo, useRef, useState } from "react";
import type { ClipLayoutEntry } from "@/lib/use-timeline-player";
import TimelineClipBlock from "./timeline-clip-block";
import { formatTimecode } from "./format";
import { PlusIcon, ScissorsIcon, TrashIcon } from "@/components/icons";

function ZoomInIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M17 17l-4-4M8.5 6v5M6 8.5h5" />
    </svg>
  );
}
function ZoomOutIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M17 17l-4-4M6 8.5h5" />
    </svg>
  );
}

const MIN_PPS = 10;
const MAX_PPS = 300;

interface TimelinePanelProps {
  layout: ClipLayoutEntry[];
  totalDurationMs: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  pixelsPerSecond: number;
  onZoomChange: (pps: number) => void;
  onTrim: (clipId: string, trimInMs: number, trimOutMs: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  splitDisabled: boolean;
}

export default function TimelinePanel({
  layout,
  totalDurationMs,
  playheadMs,
  onSeek,
  selectedClipId,
  onSelectClip,
  pixelsPerSecond,
  onZoomChange,
  onTrim,
  onReorder,
  onSplit,
  onDeleteSelected,
  splitDisabled,
}: TimelinePanelProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragFromIndex = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const scrubbing = useRef(false);

  const snapPoints = useMemo(() => {
    const points = [0, totalDurationMs, playheadMs];
    layout.forEach((e) => {
      points.push(e.startMs, e.startMs + e.durationMs);
    });
    return points;
  }, [layout, totalDurationMs, playheadMs]);

  function msFromClientX(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const px = clientX - rect.left + (trackRef.current?.scrollLeft ?? 0);
    return Math.max(0, (px / pixelsPerSecond) * 1000);
  }

  function handleTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    scrubbing.current = true;
    onSeek(msFromClientX(e.clientX));
  }
  function handleTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing.current) return;
    onSeek(msFromClientX(e.clientX));
  }
  function handleTrackPointerUp() {
    scrubbing.current = false;
  }

  function handleDrop() {
    if (dragFromIndex.current !== null && dragOverIndex !== null && dragFromIndex.current !== dragOverIndex) {
      onReorder(dragFromIndex.current, dragOverIndex);
    }
    dragFromIndex.current = null;
    setDragOverIndex(null);
  }

  const rulerMarks = useMemo(() => {
    const marks: number[] = [];
    const spanSeconds = Math.max(1, totalDurationMs / 1000);
    // Aim for a mark roughly every 80-140px regardless of zoom level.
    const targetPxGap = 100;
    const secondsPerMark = Math.max(1, Math.round(targetPxGap / pixelsPerSecond));
    for (let s = 0; s <= spanSeconds + secondsPerMark; s += secondsPerMark) marks.push(s * 1000);
    return marks;
  }, [totalDurationMs, pixelsPerSecond]);

  const contentWidth = Math.max(600, (totalDurationMs / 1000) * pixelsPerSecond + 100);
  const playheadX = (playheadMs / 1000) * pixelsPerSecond;

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-line bg-surface-2">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <button
          onClick={onSplit}
          disabled={splitDisabled}
          title="Split at playhead (S)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:border-brand disabled:opacity-30"
        >
          <ScissorsIcon width={14} height={14} /> Split
        </button>
        <button
          onClick={onDeleteSelected}
          disabled={!selectedClipId}
          title="Delete selected clip (Delete)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-danger hover:border-danger disabled:opacity-30 disabled:text-ink-muted"
        >
          <TrashIcon width={12} height={12} /> Delete
        </button>

        <span className="ml-auto font-mono text-xs tabular-nums text-ink-muted">{formatTimecode(playheadMs, true)}</span>

        <div className="ml-3 flex items-center gap-1 border-l border-line pl-3">
          <button
            onClick={() => onZoomChange(Math.max(MIN_PPS, pixelsPerSecond / 1.4))}
            title="Zoom out (Ctrl+-)"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-panel hover:text-ink"
          >
            <ZoomOutIcon />
          </button>
          <button
            onClick={() => onZoomChange(Math.min(MAX_PPS, pixelsPerSecond * 1.4))}
            title="Zoom in (Ctrl+=)"
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-panel hover:text-ink"
          >
            <ZoomInIcon />
          </button>
        </div>
      </div>

      {layout.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-ink-muted">
          <PlusIcon width={20} height={20} />
          <p className="text-sm">Add media from the left panel to build your timeline</p>
        </div>
      ) : (
        <div
          ref={trackRef}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          className="relative flex-1 cursor-text overflow-x-auto overflow-y-hidden px-2 pt-6"
        >
          <div style={{ width: contentWidth, position: "relative" }}>
            {/* Ruler */}
            <div className="pointer-events-none absolute -top-6 left-0 h-5 w-full">
              {rulerMarks.map((ms) => (
                <span
                  key={ms}
                  style={{ left: (ms / 1000) * pixelsPerSecond }}
                  className="absolute top-0 -translate-x-1/2 text-[10px] tabular-nums text-ink-muted"
                >
                  {formatTimecode(ms)}
                </span>
              ))}
            </div>

            {/* Clip row */}
            <div className="flex items-start gap-0.5" onDragLeave={() => setDragOverIndex(null)}>
              {layout.map((entry, index) => (
                <div key={entry.clip.id} className={dragOverIndex === index ? "border-l-2 border-brand" : ""}>
                  <TimelineClipBlock
                    entry={entry}
                    index={index}
                    pixelsPerSecond={pixelsPerSecond}
                    selected={selectedClipId === entry.clip.id}
                    snapPoints={snapPoints}
                    onSelect={() => onSelectClip(entry.clip.id)}
                    onTrim={(_edge, trimInMs, trimOutMs) => onTrim(entry.clip.id, trimInMs, trimOutMs)}
                    onDragStart={(i) => (dragFromIndex.current = i)}
                    onDragOverIndex={setDragOverIndex}
                    onDrop={handleDrop}
                  />
                </div>
              ))}
            </div>

            {/* Playhead */}
            <div
              className="pointer-events-none absolute -top-6 bottom-0 z-30 w-px bg-brand"
              style={{ left: playheadX }}
            >
              <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-brand" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

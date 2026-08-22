"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipLayoutEntry } from "@/lib/use-timeline-player";
import TimelineClipBlock from "./timeline-clip-block";
import { formatTimecode } from "./format";
import { CopyIcon, PlusIcon, ScissorsIcon, TrashIcon } from "@/components/icons";

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
function MarkInIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3.5v13" />
      <path d="M5 10h10.5M12 6.5l3.5 3.5-3.5 3.5" />
    </svg>
  );
}
function MarkOutIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3.5v13" />
      <path d="M15 10H4.5M8 6.5L4.5 10l3.5 3.5" />
    </svg>
  );
}
// Trash can with a left-pointing arrow — "remove, and pull what follows
// back into the space" — to distinguish it at a glance from plain Delete.
function RippleDeleteIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5.5h8M5.5 5.5V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 5.5l.6 9a1 1 0 0 0 1 .9h1.8a1 1 0 0 0 1-.9l.6-9" />
      <path d="M18 10h-5M15 7.5L12.5 10l2.5 2.5" />
    </svg>
  );
}

function RazorIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4l12 12M16 4L11.2 8.8" />
      <circle cx="5.5" cy="14.5" r="1.8" />
    </svg>
  );
}

// 10 px/s was too high a floor to ever see a long project at once: a
// 4-minute video still needed ~2,500px, three times the panel's width, so
// "Fit" couldn't actually fit. 2 px/s puts roughly 7 minutes on screen at
// a typical panel width — an overview to navigate from, with the zoom
// buttons for real work.
export const MIN_PPS = 2;
export const MAX_PPS = 300;
// Empty run-off past the end of the last clip, so the final clip's trim
// handle isn't jammed against the panel edge. Shared with zoomToFit, which
// otherwise computes a zoom that overflows by exactly this much.
const TRACK_TRAILING_PAD_PX = 100;
// Smallest gap allowed between the In and Out marks while dragging a
// selection handle — keeps the range from being dragged past itself.
const MIN_SELECTION_GAP_MS = 100;

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
  onMoveClip: (clipId: string, candidateStartMs: number) => void;
  onSplit: () => void;
  onDeleteSelected: () => void;
  onRippleDeleteSelected: () => void;
  onDuplicateSelected: () => void;
  splitDisabled: boolean;
  markInMs: number | null;
  markOutMs: number | null;
  hasMarkedRange: boolean;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onAdjustMarkIn: (ms: number) => void;
  onAdjustMarkOut: (ms: number) => void;
  onCutSelection: () => void;
  razorMode: boolean;
  onToggleRazorMode: () => void;
  onRazorClick: (ms: number) => void;
  // AI Repetitive Voice Remover: colored indicators over detected
  // repetitions — red (high-confidence, pending review), orange
  // (lower-confidence, needs review), green (already corrected).
  voiceMarkers?: { startMs: number; endMs: number; tone: "red" | "orange" | "green" }[];
}

const VOICE_MARKER_STYLES = {
  red: "bg-danger",
  orange: "bg-amber-400",
  green: "bg-success",
} as const;

// Full-duration overview scrubber, independent of the main track's zoom
// and horizontal scroll — the track above only ever shows a *portion* of
// a long video at a given zoom level, so jumping to an arbitrary point
// far outside that portion would otherwise mean scrolling or zooming out
// first. This always spans the whole clip, click/drag anywhere to seek.
function ScrubberBar({
  totalDurationMs,
  playheadMs,
  onSeek,
  voiceMarkers,
}: {
  totalDurationMs: number;
  playheadMs: number;
  onSeek: (ms: number) => void;
  voiceMarkers: { startMs: number; endMs: number; tone: "red" | "orange" | "green" }[];
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function msFromClientX(clientX: number): number {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || totalDurationMs === 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(totalDurationMs, ratio * totalDurationMs));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (totalDurationMs === 0) return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    onSeek(msFromClientX(e.clientX));
  }
  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    onSeek(msFromClientX(e.clientX));
  }
  function handlePointerUp() {
    dragging.current = false;
  }

  const playheadPct = totalDurationMs > 0 ? (playheadMs / totalDurationMs) * 100 : 0;

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
      <span className="font-mono text-[10px] tabular-nums text-ink-muted">0:00</span>
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={`relative h-2.5 flex-1 rounded-full bg-panel ${totalDurationMs === 0 ? "opacity-40" : "cursor-pointer"}`}
      >
        <div className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-brand/30" style={{ width: `${playheadPct}%` }} />
        {totalDurationMs > 0 &&
          voiceMarkers.map((marker, i) => (
            <div
              key={i}
              title={`${marker.tone === "green" ? "Corrected" : "Possible repetition"}: ${formatTimecode(marker.startMs, true)}`}
              className={`absolute top-0 h-full w-1 cursor-pointer rounded-full ${VOICE_MARKER_STYLES[marker.tone]}`}
              style={{ left: `${(marker.startMs / totalDurationMs) * 100}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSeek(marker.startMs);
              }}
            />
          ))}
        <div
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-surface shadow"
          style={{ left: `${playheadPct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-ink-muted">{formatTimecode(totalDurationMs)}</span>
    </div>
  );
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
  onMoveClip,
  onSplit,
  onDeleteSelected,
  onRippleDeleteSelected,
  onDuplicateSelected,
  splitDisabled,
  markInMs,
  markOutMs,
  hasMarkedRange,
  onMarkIn,
  onMarkOut,
  onAdjustMarkIn,
  onAdjustMarkOut,
  onCutSelection,
  razorMode,
  onToggleRazorMode,
  onRazorClick,
  voiceMarkers = [],
}: TimelinePanelProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const selectionDrag = useRef<"start" | "end" | null>(null);

  // How far the track is panned, and how far it *can* pan. At a normal zoom
  // a multi-minute video is many times wider than the panel, so without an
  // explicit way to move this window the later part of the timeline simply
  // can't be reached — the native overflow scrollbar is easy to miss and
  // hard to grab on a short track.
  const [scroll, setScroll] = useState({ left: 0, max: 0 });

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const sync = () => setScroll({ left: el.scrollLeft, max: Math.max(0, el.scrollWidth - el.clientWidth) });
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    // Zoom changes and panel resizes both change how much there is to pan.
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [totalDurationMs, pixelsPerSecond, layout.length]);

  // Keep the playhead in view when it moves out of the visible window —
  // otherwise seeking from the full-duration scrubber (or just playing past
  // the right edge) leaves the user looking at a stretch of timeline that
  // no longer has the playhead in it. Only reacts to playhead/zoom changes,
  // so panning by hand is never yanked back.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const x = (playheadMs / 1000) * pixelsPerSecond;
    const margin = 80;
    if (x < el.scrollLeft + margin) el.scrollLeft = Math.max(0, x - margin);
    else if (x > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = x - el.clientWidth + margin;
  }, [playheadMs, pixelsPerSecond]);

  // Zoom level at which the entire project fits the panel exactly — the
  // one-click way out of "my 4-minute video is 10,000px wide".
  function zoomToFit() {
    const el = trackRef.current;
    if (!el || totalDurationMs === 0) return;
    const available = Math.max(1, el.clientWidth - TRACK_TRAILING_PAD_PX - 24);
    onZoomChange(Math.min(MAX_PPS, Math.max(MIN_PPS, available / (totalDurationMs / 1000))));
    el.scrollLeft = 0;
  }

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
    return Math.max(0, Math.min(totalDurationMs, (px / pixelsPerSecond) * 1000));
  }

  function handleTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const ms = msFromClientX(e.clientX);
    if (razorMode) {
      onRazorClick(ms);
      return;
    }
    scrubbing.current = true;
    onSeek(ms);
  }
  function handleTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing.current) return;
    onSeek(msFromClientX(e.clientX));
  }
  function handleTrackPointerUp() {
    scrubbing.current = false;
  }

  function handleSelectionHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    const edge = e.currentTarget.dataset.edge as "start" | "end";
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    selectionDrag.current = edge;
  }
  function handleSelectionHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const edge = selectionDrag.current;
    if (!edge) return;
    const ms = msFromClientX(e.clientX);
    if (edge === "start") {
      const max = markOutMs !== null ? markOutMs - MIN_SELECTION_GAP_MS : totalDurationMs;
      onAdjustMarkIn(Math.max(0, Math.min(ms, max)));
    } else {
      const min = markInMs !== null ? markInMs + MIN_SELECTION_GAP_MS : 0;
      onAdjustMarkOut(Math.min(totalDurationMs, Math.max(ms, min)));
    }
  }
  function handleSelectionHandlePointerUp() {
    selectionDrag.current = null;
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

  const contentWidth = Math.max(600, (totalDurationMs / 1000) * pixelsPerSecond + TRACK_TRAILING_PAD_PX);
  const playheadX = (playheadMs / 1000) * pixelsPerSecond;

  // The in-progress selection: once In is marked, show a preview strip
  // running to the current playhead even before Out is marked, so the
  // range being built is always visible.
  const selectionStartMs = markInMs;
  const selectionEndMs = markOutMs ?? (markInMs !== null ? playheadMs : null);
  const hasSelectionPreview = selectionStartMs !== null && selectionEndMs !== null && selectionEndMs > selectionStartMs;
  const selectionLeftX = hasSelectionPreview ? (selectionStartMs! / 1000) * pixelsPerSecond : 0;
  const selectionWidthPx = hasSelectionPreview ? ((selectionEndMs! - selectionStartMs!) / 1000) * pixelsPerSecond : 0;

  return (
    /* Height grows with the controls it actually contains rather than being
       pinned to a fixed h-64: the toolbar wraps on narrower windows and the
       pan row appears only for long projects, and at a fixed height those
       pushed the full-duration scrubber off the bottom of the screen. */
    <div className="flex max-h-[45vh] min-h-56 shrink-0 flex-col border-t border-line bg-surface-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <button
          onClick={onSplit}
          disabled={splitDisabled}
          title="Split at playhead (S)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:border-brand disabled:opacity-30"
        >
          <ScissorsIcon width={14} height={14} /> Split
        </button>
        <button
          onClick={onToggleRazorMode}
          title="Razor tool — click the timeline to split there"
          aria-pressed={razorMode}
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
            razorMode ? "border-brand bg-brand/15 text-brand" : "border-line text-ink hover:border-brand"
          }`}
        >
          <RazorIcon /> Razor
        </button>

        <span className="mx-1 h-5 w-px bg-line" />

        <button
          onClick={onMarkIn}
          title="Mark start of unwanted section (I)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:border-brand"
        >
          <MarkInIcon /> Mark In
        </button>
        <button
          onClick={onMarkOut}
          title="Mark end of unwanted section (O)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:border-brand"
        >
          <MarkOutIcon /> Mark Out
        </button>
        <button
          onClick={onCutSelection}
          disabled={!hasMarkedRange}
          title="Cut the selected section and join the remainder (Delete)"
          className="flex items-center gap-1 rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-ink hover:bg-danger/90 disabled:bg-line disabled:text-ink-muted"
        >
          <TrashIcon width={12} height={12} /> Cut Selected Portion
        </button>

        <button
          onClick={onDuplicateSelected}
          disabled={!selectedClipId}
          title="Duplicate selected clip (Ctrl+D)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink hover:border-brand disabled:opacity-30"
        >
          <CopyIcon width={12} height={12} /> Duplicate
        </button>

        <button
          onClick={onDeleteSelected}
          disabled={!selectedClipId}
          title="Delete selected clip, leaving a gap (Delete)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-danger hover:border-danger disabled:opacity-30 disabled:text-ink-muted"
        >
          <TrashIcon width={12} height={12} /> Delete clip
        </button>

        <button
          onClick={onRippleDeleteSelected}
          disabled={!selectedClipId}
          title="Delete selected clip and close the gap (Shift+Delete)"
          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-danger hover:border-danger disabled:opacity-30 disabled:text-ink-muted"
        >
          <RippleDeleteIcon /> Ripple Delete
        </button>

        {hasMarkedRange && (
          <span className="font-mono text-xs tabular-nums text-ink-muted">
            {formatTimecode(markInMs!, true)} – {formatTimecode(markOutMs!, true)} ({formatTimecode(markOutMs! - markInMs!, true)})
          </span>
        )}

        <span className="ml-auto font-mono text-xs tabular-nums text-ink-muted">{formatTimecode(playheadMs, true)}</span>

        <div className="ml-3 flex items-center gap-1 border-l border-line pl-3">
          <button
            onClick={zoomToFit}
            title="Fit the whole video in the timeline"
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-panel hover:text-ink"
          >
            Fit
          </button>
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
          onPointerMove={(e) => {
            handleTrackPointerMove(e);
            handleSelectionHandlePointerMove(e);
          }}
          onPointerUp={() => {
            handleTrackPointerUp();
            handleSelectionHandlePointerUp();
          }}
          className={`relative flex-1 overflow-x-auto overflow-y-hidden px-2 pt-6 ${razorMode ? "cursor-crosshair" : "cursor-text"}`}
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

            {/* AI Repetitive Voice Remover markers */}
            {voiceMarkers.length > 0 && (
              <div className="pointer-events-none absolute -top-1 left-0 z-10 h-1.5 w-full">
                {voiceMarkers.map((marker, i) => (
                  <div
                    key={i}
                    title={`${marker.tone === "green" ? "Corrected" : "Possible repetition"}: ${formatTimecode(marker.startMs, true)}–${formatTimecode(marker.endMs, true)}`}
                    className={`pointer-events-auto absolute h-full cursor-pointer rounded-full ${VOICE_MARKER_STYLES[marker.tone]}`}
                    style={{ left: (marker.startMs / 1000) * pixelsPerSecond, width: Math.max(3, ((marker.endMs - marker.startMs) / 1000) * pixelsPerSecond) }}
                    onClick={() => onSeek(marker.startMs)}
                  />
                ))}
              </div>
            )}

            {/* Clip row — each block is absolutely positioned by its own
                startMs (free timeline placement), not flowed by flexbox,
                so a real gap or a clip dragged well past its neighbors
                renders exactly where it actually is. */}
            <div className="relative h-20">
              {layout.map((entry) => (
                <TimelineClipBlock
                  key={entry.clip.id}
                  entry={entry}
                  pixelsPerSecond={pixelsPerSecond}
                  selected={selectedClipId === entry.clip.id}
                  snapPoints={snapPoints}
                  onSelect={() => onSelectClip(entry.clip.id)}
                  onTrim={(_edge, trimInMs, trimOutMs) => onTrim(entry.clip.id, trimInMs, trimOutMs)}
                  onMove={onMoveClip}
                />
              ))}
            </div>

            {/* Unwanted-section selection: highlighted range with
                draggable edge handles, shown as soon as In is marked
                (previewing to the playhead) and finalized once Out is
                marked too. */}
            {hasSelectionPreview && (
              <div
                className={`absolute bottom-0 top-0 z-20 border-x-2 ${
                  markOutMs !== null ? "border-danger bg-danger/25" : "border-danger/60 bg-danger/10"
                }`}
                style={{ left: selectionLeftX, width: Math.max(2, selectionWidthPx) }}
              >
                <div
                  data-edge="start"
                  onPointerDown={handleSelectionHandlePointerDown}
                  title="Drag to adjust the start of the selection"
                  className="absolute inset-y-0 left-0 z-20 w-2.5 -translate-x-1/2 cursor-ew-resize"
                />
                <div
                  data-edge="end"
                  onPointerDown={handleSelectionHandlePointerDown}
                  title="Drag to adjust the end of the selection"
                  className="absolute inset-y-0 right-0 z-20 w-2.5 translate-x-1/2 cursor-ew-resize"
                />
              </div>
            )}

            {/* Playhead */}
            <div className="pointer-events-none absolute -top-6 bottom-0 z-30 w-px bg-brand" style={{ left: playheadX }}>
              <div className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-brand" />
            </div>
          </div>
        </div>
      )}

      {/* Horizontal pan. Only meaningful once the timeline is wider than
          the panel, so it's hidden rather than shown disabled when the
          whole project already fits. */}
      {scroll.max > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-muted">Scroll timeline</span>
          <input
            type="range"
            min={0}
            max={scroll.max}
            value={Math.min(scroll.left, scroll.max)}
            onChange={(e) => {
              if (trackRef.current) trackRef.current.scrollLeft = Number(e.target.value);
            }}
            title="Drag to move along the timeline"
            className="h-1.5 flex-1 accent-brand"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">
            {formatTimecode((scroll.left / pixelsPerSecond) * 1000)} –{" "}
            {formatTimecode(((scroll.left + (trackRef.current?.clientWidth ?? 0)) / pixelsPerSecond) * 1000)}
          </span>
        </div>
      )}

      <ScrubberBar totalDurationMs={totalDurationMs} playheadMs={playheadMs} onSeek={onSeek} voiceMarkers={voiceMarkers} />
    </div>
  );
}

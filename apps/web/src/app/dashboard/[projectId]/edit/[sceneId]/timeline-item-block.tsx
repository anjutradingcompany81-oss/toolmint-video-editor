"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { TimelineItem } from "@/lib/composition-api";
import type { MediaAsset } from "@/lib/projects-api";
import Waveform from "./waveform";

const MIN_DURATION_MS = 200;
const SNAP_MS = 50;

function snap(ms: number): number {
  return Math.round(ms / SNAP_MS) * SNAP_MS;
}

export interface ItemPatch {
  startMs?: number;
  durationMs?: number;
  trimInMs?: number;
  trimOutMs?: number;
}

interface TimelineItemBlockProps {
  item: TimelineItem;
  media: MediaAsset | undefined;
  pxPerSecond: number;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onUpdate: (patch: ItemPatch) => void;
}

type DragMode = "move" | "trim-left" | "trim-right";

export default function TimelineItemBlock({ item, media, pxPerSecond, selected, locked, onSelect, onUpdate }: TimelineItemBlockProps) {
  const left = (item.startMs / 1000) * pxPerSecond;
  const width = Math.max(4, (item.durationMs / 1000) * pxPerSecond);
  const label = item.type === "text" ? item.content : (media?.originalName ?? "(missing media)");
  const title = item.type === "text" ? item.content : (media?.originalName ?? item.mediaAssetId);

  // Pointer-drag state lives in a ref, not React state — updates happen on
  // every pointermove, and this data never needs to trigger a re-render on
  // its own (onUpdate already does that via the parent's state).
  const dragRef = useRef<{ mode: DragMode; startClientX: number; startItem: TimelineItem } | null>(null);

  function pxToMs(px: number): number {
    return (px / pxPerSecond) * 1000;
  }

  function beginDrag(e: ReactPointerEvent, mode: DragMode) {
    if (locked) return;
    e.stopPropagation();
    onSelect();
    dragRef.current = { mode, startClientX: e.clientX, startItem: item };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag, { once: true });
  }

  function handlePointerMove(e: globalThis.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaMs = pxToMs(e.clientX - drag.startClientX);
    const start = drag.startItem;
    const isMedia = start.type !== "text";
    const trimInMs = isMedia ? (start as Extract<TimelineItem, { trimInMs: number }>).trimInMs : 0;
    const trimOutMs = isMedia ? (start as Extract<TimelineItem, { trimOutMs: number }>).trimOutMs : 0;
    // durationMs is always the *timeline* footprint; a clip playing at
    // speedPercent != 100 consumes durationMs * speedRate of source time.
    // Every trim-drag conversion below goes through this rate to translate
    // a timeline-ms pointer delta into the source-ms delta trimIn/trimOut
    // actually track.
    const speedRate = isMedia ? (start as Extract<TimelineItem, { speedPercent: number }>).speedPercent / 100 : 1;

    if (drag.mode === "move") {
      onUpdate({ startMs: Math.max(0, snap(start.startMs + deltaMs)) });
      return;
    }

    if (drag.mode === "trim-right") {
      let newDurationMs = Math.max(MIN_DURATION_MS, snap(start.durationMs + deltaMs));
      const patch: ItemPatch = { durationMs: newDurationMs };
      if (isMedia && media?.durationMs != null) {
        // media.durationMs is the source clip's true length — NOT
        // trimInMs + durationMs + trimOutMs, which only reconstructs the
        // *currently used* span and would under-report headroom whenever a
        // clip was placed shorter than its full source (e.g. the 5s default
        // clip length from a 6s source video).
        const sourceTotalMs = media.durationMs;
        const maxDurationMs = Math.max(MIN_DURATION_MS, (sourceTotalMs - trimInMs) / speedRate);
        newDurationMs = Math.min(newDurationMs, maxDurationMs);
        patch.durationMs = newDurationMs;
        patch.trimOutMs = Math.max(0, sourceTotalMs - trimInMs - newDurationMs * speedRate);
      }
      onUpdate(patch);
      return;
    }

    // trim-left: the right edge (end time) stays fixed — start moves, and
    // duration/trimIn absorb the difference, mirroring how splitAtPlayhead
    // computes the right-hand half of a split.
    const lowerBound = Math.max(0, isMedia ? start.startMs - trimInMs / speedRate : 0);
    const upperBound = start.startMs + start.durationMs - MIN_DURATION_MS;
    const newStartMs = snap(Math.min(upperBound, Math.max(lowerBound, start.startMs + deltaMs)));
    const applied = newStartMs - start.startMs;
    const patch: ItemPatch = { startMs: newStartMs, durationMs: start.durationMs - applied };
    if (isMedia) patch.trimInMs = Math.max(0, trimInMs + applied * speedRate);
    onUpdate(patch);
  }

  function endDrag() {
    dragRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
  }

  const kindColor = item.type === "text" ? "border-amber-400/70 bg-amber-400/15" : item.type === "audio" ? "border-sky-400/70 bg-sky-400/15" : "border-[var(--tm-accent)]/70 bg-[var(--tm-accent)]/15";

  return (
    <div
      onPointerDown={(e) => beginDrag(e, "move")}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{ left, width }}
      className={`group absolute top-1 bottom-1 overflow-hidden rounded border text-left text-xs select-none ${
        selected ? "border-[var(--tm-accent)] bg-[var(--tm-accent)]/25 text-[var(--tm-text)]" : `${kindColor} text-[var(--tm-text)]`
      } ${locked ? "cursor-not-allowed opacity-70" : "cursor-grab active:cursor-grabbing"}`}
      title={title}
    >
      {item.type !== "text" && media?.waveformPeaks && media.waveformPeaks.length > 0 && (
        <Waveform
          peaks={media.waveformPeaks}
          sourceDurationMs={media.durationMs}
          trimInMs={item.trimInMs}
          durationMs={item.durationMs}
          speedPercent={item.speedPercent}
          className="pointer-events-none absolute inset-x-0 bottom-0 top-4 opacity-80"
        />
      )}
      <span className="pointer-events-none relative flex items-center gap-1 truncate px-2 leading-[2rem]">
        {label}
        {item.type !== "text" && item.speedPercent !== 100 && (
          <span className="shrink-0 rounded bg-black/50 px-1 text-[9px] font-semibold">{item.speedPercent}%</span>
        )}
      </span>

      {!locked && (
        <>
          <div
            onPointerDown={(e) => beginDrag(e, "trim-left")}
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/20"
          />
          <div
            onPointerDown={(e) => beginDrag(e, "trim-right")}
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/20"
          />
        </>
      )}
    </div>
  );
}

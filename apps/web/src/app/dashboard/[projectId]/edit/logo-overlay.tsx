"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitContainRect, type MediaClip } from "@/lib/composition-api";
import type { MediaAsset } from "@/lib/projects-api";

interface LogoOverlayProps {
  /** Overlay-track clips (logos / watermarks). */
  overlayClips: MediaClip[];
  mediaById: Map<string, MediaAsset>;
  canvasWidth: number;
  canvasHeight: number;
  playheadMs: number;
  /** Element the video is drawn into - the drag frame is measured from it. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  selectedLogoId: string | null;
  onSelect: (clipId: string | null) => void;
  /** Called continuously during a drag, in canvas pixels. */
  onMove: (clipId: string, x: number, y: number, logoSize: { width: number; height: number }) => void;
}

interface DragState {
  clipId: string;
  // Where in the logo the pointer grabbed it, in canvas pixels. Without
  // this the logo jumps so its corner meets the cursor on the first move.
  grabOffsetX: number;
  grabOffsetY: number;
  size: { width: number; height: number };
}

// Draws the logo/watermark clips on top of the preview video and lets them
// be dragged into place.
//
// Two things this fixes at once: the preview didn't show overlays at all
// (so a logo was invisible until export), and position could only be set
// through corner presets plus a margin number.
//
// Positions are stored in CANVAS pixels - the same coordinates the
// renderer's overlay filter uses - so what is dragged here is exactly what
// the exported file gets. Screen pixels are converted through
// fitContainRect rather than the container's own size, because the video
// is letterboxed inside its 16:9 box whenever the footage is a different
// shape.
export default function LogoOverlay({
  overlayClips,
  mediaById,
  canvasWidth,
  canvasHeight,
  playheadMs,
  containerRef,
  selectedLogoId,
  onSelect,
  onMove,
}: LogoOverlayProps) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const dragRef = useRef<DragState | null>(null);

  // Track the container's rendered size: the preview is fluid, and a
  // stale size would put every logo in the wrong place after a resize or
  // a panel opening beside it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  const rect = fitContainRect(box, { width: canvasWidth, height: canvasHeight });

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      const el = containerRef.current;
      if (!drag || !el || rect.scale <= 0) return;

      const bounds = el.getBoundingClientRect();
      // Screen -> canvas: subtract the element's own offset and the
      // letterbox bar, then divide by the display scale.
      const canvasX = (event.clientX - bounds.left - rect.left) / rect.scale - drag.grabOffsetX;
      const canvasY = (event.clientY - bounds.top - rect.top) / rect.scale - drag.grabOffsetY;
      onMove(drag.clipId, canvasX, canvasY, drag.size);
    },
    [containerRef, onMove, rect.left, rect.scale, rect.top],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Listeners go on the window, not the logo: a fast drag outruns the
  // element under the cursor, and without this the logo would be dropped
  // mid-gesture the moment the pointer left it.
  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [handlePointerMove, endDrag]);

  if (rect.width === 0) return null;

  // Only the logos actually on screen at the playhead are shown, so the
  // preview matches the exported frame at this instant rather than
  // stacking every overlay in the project on top of each other.
  const visible = overlayClips.filter((clip) => playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs);

  return (
    <div className="pointer-events-none absolute inset-0">
      {visible.map((clip) => {
        const asset = mediaById.get(clip.mediaAssetId);
        if (!asset?.previewUrl || !asset.width || !asset.height) return null;

        const logoW = asset.width * clip.transform.scale;
        const logoH = asset.height * clip.transform.scale;
        const selected = selectedLogoId === clip.id;

        return (
          <div
            key={clip.id}
            role="button"
            tabIndex={0}
            aria-label={`Drag ${asset.originalName} to reposition it`}
            onPointerDown={(event) => {
              event.preventDefault();
              const el = containerRef.current;
              if (!el) return;
              const bounds = el.getBoundingClientRect();
              const pointerCanvasX = (event.clientX - bounds.left - rect.left) / rect.scale;
              const pointerCanvasY = (event.clientY - bounds.top - rect.top) / rect.scale;
              dragRef.current = {
                clipId: clip.id,
                grabOffsetX: pointerCanvasX - clip.transform.x,
                grabOffsetY: pointerCanvasY - clip.transform.y,
                size: { width: logoW, height: logoH },
              };
              onSelect(clip.id);
            }}
            onKeyDown={(event) => {
              // Keyboard nudging, so placement isn't mouse-only. Shift
              // moves in bigger steps for coarse positioning.
              const step = event.shiftKey ? 10 : 1;
              const deltas: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const delta = deltas[event.key];
              if (!delta) return;
              event.preventDefault();
              onMove(clip.id, clip.transform.x + delta[0], clip.transform.y + delta[1], { width: logoW, height: logoH });
            }}
            style={{
              position: "absolute",
              left: rect.left + clip.transform.x * rect.scale,
              top: rect.top + clip.transform.y * rect.scale,
              width: logoW * rect.scale,
              height: logoH * rect.scale,
              opacity: clip.transform.opacity,
            }}
            className={`pointer-events-auto cursor-move touch-none outline-none ${
              selected ? "ring-2 ring-brand" : "ring-1 ring-white/40 hover:ring-white/80"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={asset.previewUrl} alt="" draggable={false} className="h-full w-full select-none object-contain" />
          </div>
        );
      })}
    </div>
  );
}

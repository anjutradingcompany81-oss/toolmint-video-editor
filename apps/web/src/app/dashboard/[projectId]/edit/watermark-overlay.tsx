"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fitContainRect, type WatermarkRegion } from "@/lib/composition-api";

interface WatermarkOverlayProps {
  regions: WatermarkRegion[];
  canvasWidth: number;
  canvasHeight: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: WatermarkRegion[]) => void;
}

// Which edge/corner a drag is resizing from, or "move" for the whole box.
type Handle = "move" | "nw" | "ne" | "sw" | "se";

interface DragState {
  id: string;
  handle: Handle;
  // The box as it was when the gesture started, plus where inside it the
  // pointer grabbed - so a move tracks the cursor instead of snapping its
  // corner to it, and a resize is computed against a fixed origin rather
  // than accumulating rounding error move by move.
  origin: WatermarkRegion;
  grabX: number;
  grabY: number;
}

const MIN_SIDE_PX = 8;

// The boxes marking what to erase from the footage, drawn over the preview
// and dragged/resized directly on the picture.
//
// Deliberately an outline with a label rather than a blur or a grey fill:
// `delogo` reconstructs the covered area from its surroundings, and no CSS
// effect resembles that result. Showing a fake would tell the user the
// export looks like something it will not. The panel's "Preview removal"
// button renders one real frame through the real filter instead.
export default function WatermarkOverlay({
  regions,
  canvasWidth,
  canvasHeight,
  containerRef,
  selectedId,
  onSelect,
  onChange,
}: WatermarkOverlayProps) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const dragRef = useRef<DragState | null>(null);
  // The latest regions, for the window-level move handler - it is bound
  // once per gesture and would otherwise close over a stale array.
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

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
      const canvasX = (event.clientX - bounds.left - rect.left) / rect.scale;
      const canvasY = (event.clientY - bounds.top - rect.top) / rect.scale;
      const { origin, handle } = drag;

      let next: WatermarkRegion;
      if (handle === "move") {
        next = { ...origin, x: canvasX - drag.grabX, y: canvasY - drag.grabY };
      } else {
        // Resize from the corner opposite the one being dragged, so that
        // corner stays put no matter which way the pointer goes.
        const right = origin.x + origin.width;
        const bottom = origin.y + origin.height;
        const anchorX = handle === "nw" || handle === "sw" ? right : origin.x;
        const anchorY = handle === "nw" || handle === "ne" ? bottom : origin.y;
        next = {
          ...origin,
          x: Math.min(anchorX, canvasX),
          y: Math.min(anchorY, canvasY),
          width: Math.abs(canvasX - anchorX),
          height: Math.abs(canvasY - anchorY),
        };
      }

      const clamped = clampRegion(next, canvasWidth, canvasHeight);
      onChange(regionsRef.current.map((r) => (r.id === drag.id ? clamped : r)));
    },
    [canvasHeight, canvasWidth, containerRef, onChange, rect.left, rect.scale, rect.top],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

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

  if (rect.width === 0 || regions.length === 0) return null;

  function beginDrag(event: React.PointerEvent, region: WatermarkRegion, handle: Handle) {
    event.preventDefault();
    event.stopPropagation();
    const el = containerRef.current;
    if (!el) return;
    const bounds = el.getBoundingClientRect();
    const canvasX = (event.clientX - bounds.left - rect.left) / rect.scale;
    const canvasY = (event.clientY - bounds.top - rect.top) / rect.scale;
    dragRef.current = { id: region.id, handle, origin: region, grabX: canvasX - region.x, grabY: canvasY - region.y };
    onSelect(region.id);
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {regions.map((region) => {
        const selected = selectedId === region.id;
        return (
          <div
            key={region.id}
            role="button"
            tabIndex={0}
            aria-label={`Watermark removal area, ${Math.round(region.width)} by ${Math.round(region.height)} pixels`}
            onPointerDown={(e) => beginDrag(e, region, "move")}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 10 : 1;
              const deltas: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
              };
              const delta = deltas[e.key];
              if (!delta) return;
              e.preventDefault();
              const moved = clampRegion({ ...region, x: region.x + delta[0], y: region.y + delta[1] }, canvasWidth, canvasHeight);
              onChange(regions.map((r) => (r.id === region.id ? moved : r)));
            }}
            style={{
              position: "absolute",
              left: rect.left + region.x * rect.scale,
              top: rect.top + region.y * rect.scale,
              width: region.width * rect.scale,
              height: region.height * rect.scale,
            }}
            className={`pointer-events-auto cursor-move touch-none border-2 border-dashed outline-none ${
              selected ? "border-brand bg-brand/20" : "border-white/70 bg-white/10 hover:bg-white/20"
            }`}
          >
            <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/70 px-1 text-[10px] text-white">
              Remove watermark
            </span>
            {/* Corner handles. Only on the selected box, so several
                regions don't cover the picture in dots. */}
            {selected &&
              (["nw", "ne", "sw", "se"] as const).map((handle) => (
                <span
                  key={handle}
                  onPointerDown={(e) => beginDrag(e, region, handle)}
                  style={{
                    position: "absolute",
                    [handle[0] === "n" ? "top" : "bottom"]: -5,
                    [handle[1] === "w" ? "left" : "right"]: -5,
                    cursor: handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize",
                  }}
                  className="h-2.5 w-2.5 rounded-sm border border-white bg-brand"
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

// Keeps a box inside the frame and above a usable minimum size. The
// renderer clamps again on its own (delogo needs a pixel of margin to
// sample from), but doing it here too means the number shown in the panel
// is the number that will be used, rather than one silently corrected
// later.
function clampRegion(region: WatermarkRegion, canvasWidth: number, canvasHeight: number): WatermarkRegion {
  const width = Math.round(Math.max(MIN_SIDE_PX, Math.min(region.width, canvasWidth - 2)));
  const height = Math.round(Math.max(MIN_SIDE_PX, Math.min(region.height, canvasHeight - 2)));
  return {
    ...region,
    width,
    height,
    x: Math.round(Math.min(Math.max(region.x, 1), Math.max(1, canvasWidth - 1 - width))),
    y: Math.round(Math.min(Math.max(region.y, 1), Math.max(1, canvasHeight - 1 - height))),
  };
}

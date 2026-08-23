// Removing a watermark that is burned into the footage - a station logo,
// a stock-footage mark, a corner bug - as opposed to deleting a logo the
// user added themselves (that is just removing an overlay clip).
//
// This uses ffmpeg's `delogo`, which interpolates each covered pixel from
// the ones just outside the box. That is a real filter doing real work,
// not a blur pasted over the top, but it is also not magic: it does well
// on flat or softly-varying backgrounds and leaves a visible smudge over
// busy detail or hard edges. The UI says so rather than implying a clean
// erase in every case.

export interface WatermarkRegion {
  id: string;
  /** Canvas pixels - the same coordinate space overlay positions use. */
  x: number;
  y: number;
  width: number;
  height: number;
}

// delogo samples the pixels immediately surrounding the box, so the box
// cannot sit flush against the frame edge - there would be nothing on the
// outside to interpolate from, and ffmpeg fails the whole render with
// "Logo area is outside of the frame". Keeping one pixel of margin turns
// that hard failure into a one-pixel difference nobody can see.
const EDGE_MARGIN_PX = 1;
const MIN_SIDE_PX = 2;

/**
 * Clamps a region into the frame, leaving the margin delogo needs.
 * Returns null when the region cannot be made usable (zero-sized, or a
 * frame too small to hold anything), so the caller can drop it instead of
 * emitting a filter that would abort the export.
 */
export function clampWatermarkRegion(
  region: WatermarkRegion,
  canvas: { width: number; height: number },
): { x: number; y: number; w: number; h: number } | null {
  const maxRight = canvas.width - EDGE_MARGIN_PX;
  const maxBottom = canvas.height - EDGE_MARGIN_PX;
  if (maxRight - EDGE_MARGIN_PX < MIN_SIDE_PX || maxBottom - EDGE_MARGIN_PX < MIN_SIDE_PX) return null;

  const x = Math.round(Math.min(Math.max(region.x, EDGE_MARGIN_PX), maxRight - MIN_SIDE_PX));
  const y = Math.round(Math.min(Math.max(region.y, EDGE_MARGIN_PX), maxBottom - MIN_SIDE_PX));
  const w = Math.round(Math.min(region.width, maxRight - x));
  const h = Math.round(Math.min(region.height, maxBottom - y));

  if (w < MIN_SIDE_PX || h < MIN_SIDE_PX) return null;
  return { x, y, w, h };
}

/**
 * One comma-joined `delogo` chain for every usable region, or "" when
 * there are none. Chained rather than combined because delogo covers a
 * single rectangle per instance; several marks means several passes.
 */
export function buildDelogoFilter(regions: WatermarkRegion[], canvas: { width: number; height: number }): string {
  return regions
    .map((region) => clampWatermarkRegion(region, canvas))
    .filter((r): r is { x: number; y: number; w: number; h: number } => r !== null)
    .map((r) => `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}`)
    .join(",");
}

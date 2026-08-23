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

// How a marked area is dealt with. RECONSTRUCT is the honest "remove it"
// option; the other two cover the case it handles badly.
//
// delogo rebuilds each covered pixel from the ring just outside the box,
// which is genuinely invisible over flat or softly-varying backgrounds and
// an obvious smear over grass, foliage or text. On that kind of footage a
// clean blur or pixelation reads as a deliberate edit rather than damage,
// which is usually what someone actually wants.
export type WatermarkMode = "RECONSTRUCT" | "BLUR" | "PIXELATE";

export interface WatermarkRegion {
  id: string;
  /** Canvas pixels - the same coordinate space overlay positions use. */
  x: number;
  y: number;
  width: number;
  height: number;
  mode?: WatermarkMode;
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

/**
 * Canvas pixels -> output pixels.
 *
 * The editor positions everything (watermark boxes, logo overlays) against
 * a canvas the size of the first video clip's source. The export canvas is
 * whatever the chosen resolution works out to, which is only the same thing
 * for "Original". Exporting the very same project at 720p therefore has to
 * move and resize that geometry, or a watermark box lands somewhere else
 * entirely — erasing clean picture and leaving the mark untouched.
 */
export function canvasToOutputScale(
  canvas: { width: number; height: number },
  output: { width: number; height: number },
): { x: number; y: number } {
  // Guard against a zero/unknown canvas rather than emitting Infinity into
  // a filter string.
  const x = canvas.width > 0 ? output.width / canvas.width : 1;
  const y = canvas.height > 0 ? output.height / canvas.height : 1;
  return { x, y };
}

export function scaleWatermarkRegion(region: WatermarkRegion, scale: { x: number; y: number }): WatermarkRegion {
  return {
    ...region,
    x: Math.round(region.x * scale.x),
    y: Math.round(region.y * scale.y),
    width: Math.round(region.width * scale.x),
    height: Math.round(region.height * scale.y),
  };
}

// Blur radius and pixel-block size are derived from the region rather than
// fixed, so a small corner bug and a large banner are both obscured to the
// same degree instead of one being barely touched and the other destroyed.
function blurRadius(w: number, h: number): number {
  // boxblur's radius must stay under half the region, or ffmpeg errors.
  return Math.max(2, Math.min(Math.floor(Math.min(w, h) / 4), 40));
}
function pixelBlock(w: number, h: number): number {
  return Math.max(2, Math.min(Math.floor(Math.min(w, h) / 6), 32));
}

/**
 * The filter-graph entries that obscure every region, reading `inLabel`
 * and producing `outLabel`. Returns [] when there is nothing to do, so the
 * caller can leave the chain untouched.
 *
 * RECONSTRUCT chains delogo passes directly. BLUR and PIXELATE can't work
 * that way — they have to cut the region out, treat it, and paste it back
 * — so each region becomes a split/crop/overlay step threaded through the
 * graph.
 */
export function buildWatermarkFilterParts(
  regions: WatermarkRegion[],
  canvas: { width: number; height: number },
  inLabel: string,
  outLabel: string,
): string[] {
  const usable = regions
    .map((region) => ({ region, rect: clampWatermarkRegion(region, canvas) }))
    .filter((entry): entry is { region: WatermarkRegion; rect: { x: number; y: number; w: number; h: number } } => entry.rect !== null);

  if (usable.length === 0) return [];

  const parts: string[] = [];
  let current = inLabel;

  // All the delogo regions collapse into one chain — it filters in place,
  // so there is no need to cut anything out.
  const reconstruct = usable.filter((e) => (e.region.mode ?? "RECONSTRUCT") === "RECONSTRUCT");
  const cutouts = usable.filter((e) => (e.region.mode ?? "RECONSTRUCT") !== "RECONSTRUCT");

  if (reconstruct.length > 0) {
    const chain = reconstruct.map((e) => `delogo=x=${e.rect.x}:y=${e.rect.y}:w=${e.rect.w}:h=${e.rect.h}`).join(",");
    const next = cutouts.length > 0 ? `${outLabel}_d` : outLabel;
    parts.push(`[${current}]${chain}[${next}]`);
    current = next;
  }

  cutouts.forEach((entry, i) => {
    const { rect } = entry;
    const last = i === cutouts.length - 1;
    const next = last ? outLabel : `${outLabel}_${i}`;
    const treated = `${outLabel}_fx${i}`;
    const keep = `${outLabel}_k${i}`;
    const copy = `${outLabel}_c${i}`;

    const effect =
      (entry.region.mode ?? "RECONSTRUCT") === "BLUR"
        ? `boxblur=${blurRadius(rect.w, rect.h)}:2`
        : // Scale down then straight back up with nearest-neighbour: the
          // detail is genuinely thrown away, so nothing can be recovered
          // from the result the way a reversible blur sometimes can be.
          `scale=iw/${pixelBlock(rect.w, rect.h)}:ih/${pixelBlock(rect.w, rect.h)}:flags=neighbor,` +
          `scale=${rect.w}:${rect.h}:flags=neighbor`;

    parts.push(`[${current}]split=2[${keep}][${copy}]`);
    parts.push(`[${copy}]crop=${rect.w}:${rect.h}:${rect.x}:${rect.y},${effect}[${treated}]`);
    parts.push(`[${keep}][${treated}]overlay=${rect.x}:${rect.y}[${next}]`);
    current = next;
  });

  return parts;
}

// Fade in / fade out for a clip, in both picture and sound.
//
// The lengths are stored per clip and measured inward from each end, so
// they are expressed in CLIP-LOCAL time. That matters for where the
// filters go: the visual chain shifts each clip to its timeline position
// in the same setpts expression that normalises it, so a fade inserted
// after that shift would be timed against the whole timeline and fire at
// the wrong moment (or never, for a clip that starts late). The fades have
// to be applied while the clip's own time still starts at zero.

const MIN_FADE_MS = 1;

export interface FadeSpec {
  fadeInMs: number;
  fadeOutMs: number;
  durationMs: number;
}

/** Clamps the pair so they fit inside the clip and cannot overlap. */
export function resolveFades({ fadeInMs, fadeOutMs, durationMs }: FadeSpec): { inMs: number; outMs: number } {
  const safeDuration = Math.max(0, durationMs);
  const inMs = Math.max(0, Math.min(fadeInMs, safeDuration));
  // The fade-out only gets whatever the fade-in didn't take. Letting them
  // overlap makes a clip that never reaches full brightness, which reads
  // as a broken render rather than a deliberate effect.
  const outMs = Math.max(0, Math.min(fadeOutMs, safeDuration - inMs));
  return { inMs: inMs < MIN_FADE_MS ? 0 : inMs, outMs: outMs < MIN_FADE_MS ? 0 : outMs };
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/**
 * Video fade filters, in clip-local time, or "" when there is nothing to
 * do. `alpha` fades transparency instead of towards black — needed for
 * overlay clips, which sit on top of other picture and should reveal what
 * is underneath rather than punching a black hole in it.
 */
export function buildVideoFadeFilters(spec: FadeSpec, alpha = false): string {
  const { inMs, outMs } = resolveFades(spec);
  const alphaArg = alpha ? ":alpha=1" : "";
  const parts: string[] = [];
  if (inMs > 0) parts.push(`fade=t=in:st=${sec(0)}:d=${sec(inMs)}${alphaArg}`);
  if (outMs > 0) parts.push(`fade=t=out:st=${sec(spec.durationMs - outMs)}:d=${sec(outMs)}${alphaArg}`);
  return parts.join(",");
}

/** The same for sound. */
export function buildAudioFadeFilters(spec: FadeSpec): string {
  const { inMs, outMs } = resolveFades(spec);
  const parts: string[] = [];
  if (inMs > 0) parts.push(`afade=t=in:st=${sec(0)}:d=${sec(inMs)}`);
  if (outMs > 0) parts.push(`afade=t=out:st=${sec(spec.durationMs - outMs)}:d=${sec(outMs)}`);
  return parts.join(",");
}

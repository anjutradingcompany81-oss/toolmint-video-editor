// Crossfades (dissolves) between neighbouring clips on the same track.
//
// The timeline forbids two clips on one track from overlapping in time,
// but a dissolve is precisely two clips on screen at once — so the overlap
// exists only at render time, and nothing about the saved timeline moves.
// That is deliberate: a transition that shifted its neighbours would make
// the exported file disagree with the timeline the user arranged.
//
// The dissolve occupies the FIRST `transitionInMs` of the later clip. Over
// that window the later clip fades its alpha up from nothing while the
// earlier clip is held on screen underneath, so the picture mixes from one
// to the other. The earlier clip therefore has to keep playing past its
// own out-point for the length of the transition, which is what
// `tailExtensionMs` below is for.

export interface TransitionClip {
  id: string;
  trackId: string;
  startMs: number;
  durationMs: number;
  transitionInMs?: number;
}

export interface TransitionPlanEntry {
  /** Alpha fade-up length for this clip — the dissolve itself. */
  dissolveInMs: number;
  /** How long this clip must linger past its out-point, under its successor. */
  tailExtensionMs: number;
}

// Clip boundaries come from millisecond arithmetic, so "these two touch"
// has to tolerate a frame's worth of rounding rather than demanding exact
// equality.
const ADJACENCY_TOLERANCE_MS = 40;

/**
 * Resolves every clip's dissolve, and the tail its predecessor needs.
 *
 * A transition is ignored (rather than half-applied) when there is no clip
 * immediately before this one on the same track: dissolving from black is
 * what fadeInMs already does, and silently turning one into the other
 * would be surprising.
 */
export function planTransitions(clips: TransitionClip[]): Map<string, TransitionPlanEntry> {
  const plan = new Map<string, TransitionPlanEntry>();
  const entry = (id: string): TransitionPlanEntry => {
    let e = plan.get(id);
    if (!e) {
      e = { dissolveInMs: 0, tailExtensionMs: 0 };
      plan.set(id, e);
    }
    return e;
  };

  const byTrack = new Map<string, TransitionClip[]>();
  for (const clip of clips) {
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }

  for (const list of byTrack.values()) {
    const ordered = [...list].sort((a, b) => a.startMs - b.startMs);
    for (const [index, clip] of ordered.entries()) {
      const requested = clip.transitionInMs ?? 0;
      if (requested <= 0 || index === 0) continue;

      const previous = ordered[index - 1]!;
      const touches = Math.abs(previous.startMs + previous.durationMs - clip.startMs) <= ADJACENCY_TOLERANCE_MS;
      if (!touches) continue;

      // A dissolve can't outlast either clip: longer than the incoming one
      // and it never becomes fully opaque; longer than the outgoing one and
      // it would still be showing a clip that has entirely finished.
      const dissolveInMs = Math.min(requested, clip.durationMs, previous.durationMs);
      if (dissolveInMs <= 0) continue;

      entry(clip.id).dissolveInMs = dissolveInMs;
      // Whichever successor needs the longest hold wins — a clip can only
      // be extended once, however many neighbours ask.
      const prev = entry(previous.id);
      prev.tailExtensionMs = Math.max(prev.tailExtensionMs, dissolveInMs);
    }
  }

  return plan;
}

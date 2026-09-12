// Turns a flat list of AI-generated narration lines (just text — a
// language model's own guess at how long it takes to speak something is
// not a number worth trusting) into timeline positions, laid back-to-back
// across the target duration. Each line's share of the total is
// proportional to its own word count, so a long sentence gets more time
// than "Okay." sitting next to it — an even split would either rush the
// long lines or leave the short ones stranded in dead air.
export interface LaidOutLine {
  text: string;
  startMs: number;
  durationMs: number;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length || 1; // never zero — an empty-ish line still gets a fair share, not none
}

export function layoutScriptLines(lines: string[], totalDurationMs: number): LaidOutLine[] {
  if (lines.length === 0) return [];
  const safeTotalMs = Math.max(1, totalDurationMs);

  const weights = lines.map(wordCount);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let cursorMs = 0;
  const laidOut: LaidOutLine[] = [];
  lines.forEach((text, i) => {
    const isLast = i === lines.length - 1;
    // The last line soaks up any rounding remainder instead of leaving a
    // sliver of unaccounted time (or overshooting) at the very end.
    const durationMs = isLast ? Math.max(1, safeTotalMs - cursorMs) : Math.max(1, Math.round((weights[i] / totalWeight) * safeTotalMs));
    laidOut.push({ text, startMs: cursorMs, durationMs });
    cursorMs += durationMs;
  });
  return laidOut;
}

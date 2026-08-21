// Pure text-comparison helpers for the AI Repetitive Voice Remover — no ML
// model involved here, just string math. Script-agnostic (works the same
// on Devanagari and Latin text), which is what lets Hindi, English, and
// mixed Hindi-English dialogue all flow through the same comparison.

// Strips punctuation and collapses whitespace so "Hello, world!" and
// "hello world" compare as identical — repetition-relevant differences are
// in the words themselves, not stray punctuation a transcriber may or may
// not have emitted.
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    // \p{M} (combining marks) matters as much as \p{L} here — Devanagari
    // vowel signs and the virama are marks, not letters, so omitting them
    // would silently mangle every Hindi word that uses one (i.e. most of
    // them).
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + cost));
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

// 1 = identical (after normalization), 0 = nothing in common.
export function charSimilarity(a: string, b: string): number {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (na.length === 0 && nb.length === 0) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

// Word-level Jaccard overlap — catches near-duplicate phrases with minor
// word-order differences or a dropped filler word that character-level
// Levenshtein alone would under-score.
export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeForComparison(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeForComparison(b).split(" ").filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

// Blends character-level and word-level similarity — weighted toward the
// character metric (more sensitive to exact accidental repeats, which is
// the primary target) while the token metric prevents word-order noise
// from masking an obvious repeat.
export function textSimilarity(a: string, b: string): number {
  return charSimilarity(a, b) * 0.6 + tokenSimilarity(a, b) * 0.4;
}

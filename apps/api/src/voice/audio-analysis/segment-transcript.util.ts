// Pure helper: groups Whisper's word-level output into sentence/phrase-ish
// segments by pause length, since the repetition detector reasons about
// segments (a "line" someone said), not individual words. No ML here —
// this only shapes whatever timestamps Whisper already produced.
export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptChunk {
  text: string;
  startMs: number;
  endMs: number;
}

const SENTENCE_END_RE = /[.!?।]$/; // "।" is the Hindi/Devanagari sentence-ending danda

// A new segment starts when the pause since the last word exceeds
// maxPauseMs, OR the previous word ended a sentence — whichever comes
// first keeps segments from running two full sentences together just
// because the speaker didn't pause between them.
export function groupWordsIntoSegments(words: WordTiming[], maxPauseMs = 700): TranscriptChunk[] {
  if (words.length === 0) return [];

  const segments: TranscriptChunk[] = [];
  let current: WordTiming[] = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const word = words[i];
    const pauseMs = word.startMs - prev.endMs;
    const prevEndedSentence = SENTENCE_END_RE.test(prev.text.trim());

    if (pauseMs > maxPauseMs || prevEndedSentence) {
      segments.push(...splitOnImmediateRepeats(current).map(toChunk));
      current = [word];
    } else {
      current.push(word);
    }
  }
  segments.push(...splitOnImmediateRepeats(current).map(toChunk));
  return segments;
}

function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

const MAX_REPEAT_PHRASE_WORDS = 6;

// Pause-based grouping alone runs a word/phrase repeated *within one
// breath* (no pause between the two repeats) into a single segment's
// text — confirmed live on real Hindi content: "...raajneeti zyada hoti
// zyada hoti" transcribed correctly as one continuous phrase, but the
// repetition detector compares *pairs of segments*, so a duplicate
// sitting inside one segment's own text was invisible to it. This finds
// the longest immediately-adjacent repeated word sequence (checked from
// MAX_REPEAT_PHRASE_WORDS down to 1) and splits the segment into
// [context-before, repeat-occurrence-1, repeat-occurrence-2,
// ...context-after via recursion] so the two occurrences become their
// own directly-comparable segments — at which point the existing
// segment-vs-segment detector already handles it correctly.
export function splitOnImmediateRepeats(words: WordTiming[]): WordTiming[][] {
  const maxLen = Math.min(MAX_REPEAT_PHRASE_WORDS, Math.floor(words.length / 2));
  for (let len = maxLen; len >= 1; len--) {
    for (let start = 0; start + len * 2 <= words.length; start++) {
      const a = words.slice(start, start + len);
      const b = words.slice(start + len, start + len * 2);
      if (a.every((w, i) => normalizeWord(w.text) === normalizeWord(b[i].text) && normalizeWord(w.text) !== "")) {
        const before = words.slice(0, start);
        const after = words.slice(start + len * 2);
        const groups: WordTiming[][] = [];
        if (before.length > 0) groups.push(...splitOnImmediateRepeats(before));
        groups.push(a, b);
        if (after.length > 0) groups.push(...splitOnImmediateRepeats(after));
        return groups;
      }
    }
  }
  return [words];
}

function toChunk(words: WordTiming[]): TranscriptChunk {
  return {
    text: words
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    startMs: words[0].startMs,
    endMs: words[words.length - 1].endMs,
  };
}

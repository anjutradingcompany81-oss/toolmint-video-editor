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
      segments.push(toChunk(current));
      current = [word];
    } else {
      current.push(word);
    }
  }
  segments.push(toChunk(current));
  return segments;
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

// Pure, ML-free repetition-detection logic for the AI Repetitive Voice
// Remover. Takes an already-transcribed, already-diarized, already
// audio-fingerprinted list of speech segments (the *output* of Whisper +
// pyannote + audio-features.util.ts — see voice-scan.processor.ts) and
// decides which nearby pairs look like an accidental duplicate, with what
// confidence, and how it should be fixed. Kept ML-free and pure so the
// actual detection *logic* — the part product correctness hinges on — is
// fully unit-testable without a model runtime.
import { textSimilarity } from "./text-similarity.util";

export type RepetitionKind = "WORD" | "PHRASE" | "SENTENCE" | "CLIP_OVERLAP" | "SCENE_JOIN" | "RENDER_DUPLICATE";
export type ConfidenceBucket = "HIGH" | "MEDIUM" | "LOW";
export type CorrectionMode = "AUDIO_ONLY" | "AUDIO_VIDEO_TRIM";

export interface TranscriptSegment {
  id: string;
  trackId: string;
  clipId: string;
  mediaAssetId: string;
  // Timeline-absolute ms, and source-local ms (into the clip's own media
  // asset) — the detector reasons in timeline coordinates (gap, ordering)
  // but callers need source coordinates to build the correction itself.
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  text: string;
  // Undefined when diarization couldn't determine a speaker (e.g. it's
  // disabled, or the model failed) — treated as "unknown", never used to
  // rule two segments out, since a false "different speaker" skip would
  // hide a real accidental duplicate.
  speakerLabel?: string;
  // Averaged MFCC vector — see audio-features.util.ts.
  audioFingerprint: number[];
  // Waveform energy envelope — see audio-features.util.ts.
  waveformEnvelope: number[];
  // Estimated fundamental frequency in Hz, 0 if no clear pitch was found
  // (silence/noise) — see audio-features.util.ts. This is the primary
  // *speaker* signal (confirmed live: MFCC alone scored a male and female
  // voice reading the identical sentence at 0.99 similarity — nowhere
  // near enough to protect "different characters, same line" without
  // diarization actually being configured).
  pitchHz: number;
}

export interface SensitivityThresholds {
  transcriptSimilarityPct: number;
  audioSimilarityPct: number;
  maxGapMs: number;
  minSegmentDurationMs: number;
  confidenceThreshold: number;
}

export type SensitivityPreset = "LOW" | "BALANCED" | "HIGH";

// LOW sensitivity = fewer, more certain results (only near-exact repeats
// close together); HIGH = casts a much wider net, at the cost of more
// false positives needing manual review. BALANCED is the default.
export const SENSITIVITY_PRESETS: Record<SensitivityPreset, SensitivityThresholds> = {
  LOW: { transcriptSimilarityPct: 92, audioSimilarityPct: 80, maxGapMs: 6000, minSegmentDurationMs: 400, confidenceThreshold: 0.8 },
  BALANCED: { transcriptSimilarityPct: 80, audioSimilarityPct: 65, maxGapMs: 15000, minSegmentDurationMs: 250, confidenceThreshold: 0.6 },
  HIGH: { transcriptSimilarityPct: 65, audioSimilarityPct: 50, maxGapMs: 30000, minSegmentDurationMs: 150, confidenceThreshold: 0.4 },
};

export interface RepetitionCandidate {
  original: TranscriptSegment;
  repeated: TranscriptSegment;
  kind: RepetitionKind;
  transcriptSimilarity: number;
  audioSimilarity: number;
  timingGapMs: number;
  confidenceScore: number;
  confidenceBucket: ConfidenceBucket;
  suggestedMode: CorrectionMode;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Common short words ("hai", "and", "ki", "the"...) recur constantly in
// ordinary speech — a match window as wide as the configured maxGapMs
// (up to 30s on HIGH sensitivity) turns nearly every reuse of a filler
// word across a whole scene into a flagged "repetition", flooding the
// review panel with non-mistakes. A real accidental duplicate — a
// stutter or an editor replaying a line — sits right next to its
// original; the longer a *short* phrase's natural recurrence gap gets,
// the less likely it's a mistake and the more likely it's just how
// people talk. Longer phrases/sentences are inherently unlikely to recur
// by coincidence, so they keep the full configured gap.
function effectiveMaxGapMs(words: number, configuredMaxGapMs: number): number {
  if (words <= 1) return Math.min(configuredMaxGapMs, 2000);
  if (words <= 4) return Math.min(configuredMaxGapMs, 6000);
  return configuredMaxGapMs;
}

function classifyKind(a: TranscriptSegment, b: TranscriptSegment, gapMs: number, audioSimilarity: number): RepetitionKind {
  const overlaps = a.trackId === b.trackId ? Math.max(a.startMs, b.startMs) < Math.min(a.endMs, b.endMs) : false;
  if (overlaps) return "CLIP_OVERLAP";
  // Near-perfect waveform/spectral match is the signature of literally the
  // same audio samples playing twice (a render or timeline-join bug), as
  // opposed to two independent (if very similar) human takes.
  if (audioSimilarity >= 0.97) return "RENDER_DUPLICATE";
  // "Scene join" specifically means the repeat straddles the seam between
  // two *different* clips on the timeline — a stutter or repeated word
  // within one continuous take (same clip, same close gap) is a WORD/
  // PHRASE/SENTENCE repeat, not a join artifact, even though both have a
  // small timing gap.
  if (a.clipId !== b.clipId && gapMs <= 1500) return "SCENE_JOIN";
  return classifyTextUnit(a.text);
}

// Sentence-final punctuation across the scripts this product actually
// handles: Latin (. ? !) and Devanagari danda / double danda (। ॥).
const SENTENCE_END = /[.?!।॥]\s*$/;

// Word count alone mislabels short-but-complete sentences, and it does so
// asymmetrically by language: "हम कल बैठक करेंगे" is a whole sentence in
// four words, where the English equivalent ("we will hold the meeting
// tomorrow") is six. Reporting that to the user as a "Repeated phrase"
// when they can plainly see a repeated sentence is exactly the kind of
// mislabelling that erodes trust in the whole feature, so punctuation —
// which Whisper does emit — is treated as the stronger signal, with word
// count only as the fallback when there is none.
export function classifyTextUnit(text: string): "WORD" | "PHRASE" | "SENTENCE" {
  const trimmed = text.trim();
  const words = wordCount(trimmed);
  if (words <= 1) return "WORD";
  if (SENTENCE_END.test(trimmed)) return "SENTENCE";
  return words <= 3 ? "PHRASE" : "SENTENCE";
}

// Cosine similarity of two vectors, 0 when dimensions mismatch — shared
// tiny helper so this file doesn't need to import audio-features.util.ts
// just to avoid duplicating four lines of math.
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Weighted blend feeding the final confidence score — transcript
// similarity carries the most weight (a repetition is fundamentally about
// what was *said*), audio similarity is next (distinguishes an accidental
// duplicate take from typed-identical-but-differently-delivered dialogue),
// waveform correlation last (mostly useful for confirming CLIP_OVERLAP/
// RENDER_DUPLICATE, noisy as a general-purpose signal on its own).
const WEIGHTS = { transcript: 0.5, audio: 0.35, waveform: 0.15 };

export function detectRepetitions(segments: TranscriptSegment[], thresholds: SensitivityThresholds): RepetitionCandidate[] {
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  const candidates: RepetitionCandidate[] = [];

  // How many times each normalized text appears across the whole scanned
  // scope — 3+ occurrences of literally the same line is the fingerprint
  // of an intentional refrain (song chorus, catchphrase), not an
  // accidental duplicate, which is almost always exactly two occurrences
  // close together. Every pairing of a 3+-repeated line is capped below
  // HIGH confidence so it always requires manual review instead of ever
  // being eligible for "Correct All High-Confidence".
  const occurrenceCount = new Map<string, number>();
  for (const seg of ordered) {
    const key = seg.text.trim().toLowerCase();
    occurrenceCount.set(key, (occurrenceCount.get(key) ?? 0) + 1);
  }

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (a.endMs - a.startMs < thresholds.minSegmentDurationMs) continue;
    const tightGapMs = effectiveMaxGapMs(wordCount(a.text), thresholds.maxGapMs);

    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      const gapMs = b.startMs - a.endMs;
      if (gapMs > thresholds.maxGapMs) break; // ordered by start time, so nothing further out needs checking either
      if (b.endMs - b.startMs < thresholds.minSegmentDurationMs) continue;

      // Different speakers saying the same line is dialogue, not a
      // mistake — never flagged, regardless of how similar the text or
      // audio is. Only skip when we're actually sure they differ; unknown
      // speaker labels never trigger this.
      if (a.speakerLabel && b.speakerLabel && a.speakerLabel !== b.speakerLabel) continue;

      const transcriptSim = textSimilarity(a.text, b.text);
      if (transcriptSim * 100 < thresholds.transcriptSimilarityPct) continue;

      const audioSim = Math.max(0, Math.min(1, (cosine(a.audioFingerprint, b.audioFingerprint) + 1) / 2));
      if (audioSim * 100 < thresholds.audioSimilarityPct) continue;

      // A short word/phrase recurring beyond its tight gap is almost
      // always ordinary speech reusing a common word, not a mistake —
      // unless the audio itself is a near-perfect match (literally the
      // same samples), which only a genuine render/clip-duplication bug
      // produces. Longer phrases/sentences aren't gated here; coincidental
      // reuse of a whole sentence is rare enough to trust transcript+audio
      // similarity alone.
      if (gapMs > tightGapMs && audioSim < 0.97) continue;

      const waveformSim = cosine(a.waveformEnvelope, b.waveformEnvelope);

      let confidence = transcriptSim * WEIGHTS.transcript + audioSim * WEIGHTS.audio + Math.max(0, waveformSim) * WEIGHTS.waveform;

      const repeatsElsewhere = (occurrenceCount.get(a.text.trim().toLowerCase()) ?? 1) >= 3;
      if (repeatsElsewhere) confidence = Math.min(confidence, 0.59); // never HIGH — likely an intentional refrain

      // A large pitch mismatch is a strong hint these are two *different*
      // speakers that diarization didn't catch (unavailable, or failed) —
      // confirmed live: a male and female voice reading the identical
      // line scored 0.99 on MFCC similarity alone, which would otherwise
      // have gone straight to HIGH confidence. This is a *soft* cap, not
      // a skip, unlike the speaker-label check above — pitch is an
      // inferred signal, not a certainty, so a suspicious pair still
      // surfaces for manual review rather than being hidden outright.
      const pitchMismatch = a.pitchHz > 0 && b.pitchHz > 0 && Math.abs(a.pitchHz - b.pitchHz) / Math.max(a.pitchHz, b.pitchHz) > 0.2;
      if (pitchMismatch) confidence = Math.min(confidence, 0.75);

      const bucket: ConfidenceBucket =
        confidence >= 0.8 && !repeatsElsewhere && !pitchMismatch ? "HIGH" : confidence >= thresholds.confidenceThreshold ? "MEDIUM" : "LOW";
      if (confidence < Math.min(thresholds.confidenceThreshold, 0.4)) continue; // below any bucket - not worth surfacing at all

      const kind = classifyKind(a, b, gapMs, audioSim);
      // A literal clip/render duplication (same samples, same or
      // overlapping video) needs the interval actually removed, not just
      // muted, or the visual would still show the duplicated action —
      // everything else defaults to preserving video duration.
      const suggestedMode: CorrectionMode = kind === "CLIP_OVERLAP" || kind === "RENDER_DUPLICATE" ? "AUDIO_VIDEO_TRIM" : "AUDIO_ONLY";

      candidates.push({
        original: a,
        repeated: b,
        kind,
        transcriptSimilarity: transcriptSim,
        audioSimilarity: audioSim,
        timingGapMs: gapMs,
        confidenceScore: confidence,
        confidenceBucket: bucket,
        suggestedMode,
      });
    }
  }

  return collapseChains(dedupeToNearestOriginal(candidates));
}

// The pairwise scan above can report the same "repeated" segment against
// several earlier occurrences at once (e.g. a phrase said 3 times gives a
// segment-3-vs-1 candidate *and* a segment-3-vs-2 candidate) — keeping
// only the nearest original per repeated segment collapses that back down
// to one candidate per actual repeat, the same way a person would describe
// it ("this line repeats", not "this line relates to 3 other lines").
function dedupeToNearestOriginal(candidates: RepetitionCandidate[]): RepetitionCandidate[] {
  const bestByRepeatedId = new Map<string, RepetitionCandidate>();
  for (const c of candidates) {
    const existing = bestByRepeatedId.get(c.repeated.id);
    if (!existing || c.timingGapMs < existing.timingGapMs) bestByRepeatedId.set(c.repeated.id, c);
  }
  return [...bestByRepeatedId.values()].sort((a, b) => a.repeated.startMs - b.repeated.startMs);
}

const BUCKET_RANK: Record<ConfidenceBucket, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

// A phrase that keeps recurring back-to-back (a Whisper hallucination loop
// on silent/noisy audio is the most common real-world cause, but a genuine
// human stutter chain looks the same) chains up into original->repeated,
// repeated->original->repeated, and so on. Surfacing every link as its own
// result means a single 20-second hallucinated run floods the review panel
// with a dozen-plus overlapping "repetitions" — and applying them one by
// one would repeatedly re-cut the same stretch of the clip. Collapsing a
// whole chain into one result (first original through last repeated) turns
// it into the single actionable "this stretch repeats" item a person would
// actually want to review and fix in one move.
function collapseChains(deduped: RepetitionCandidate[]): RepetitionCandidate[] {
  const sorted = [...deduped].sort((a, b) => a.repeated.startMs - b.repeated.startMs);
  const collapsed: RepetitionCandidate[] = [];
  let chain: RepetitionCandidate[] = [];

  const flushChain = () => {
    if (chain.length === 0) return;
    if (chain.length === 1) {
      collapsed.push(chain[0]);
    } else {
      const head = chain[0];
      const tail = chain[chain.length - 1];
      const worstBucket = chain.reduce<ConfidenceBucket>(
        (worst, c) => (BUCKET_RANK[c.confidenceBucket] < BUCKET_RANK[worst] ? c.confidenceBucket : worst),
        chain[0].confidenceBucket,
      );
      collapsed.push({
        original: head.original,
        repeated: tail.repeated,
        kind: head.kind,
        transcriptSimilarity: Math.min(...chain.map((c) => c.transcriptSimilarity)),
        audioSimilarity: Math.min(...chain.map((c) => c.audioSimilarity)),
        timingGapMs: head.timingGapMs,
        confidenceScore: Math.min(...chain.map((c) => c.confidenceScore)),
        confidenceBucket: worstBucket,
        suggestedMode: head.suggestedMode,
      });
    }
    chain = [];
  };

  for (const c of sorted) {
    if (chain.length > 0 && chain[chain.length - 1].repeated.id !== c.original.id) flushChain();
    chain.push(c);
  }
  flushChain();

  return collapsed;
}

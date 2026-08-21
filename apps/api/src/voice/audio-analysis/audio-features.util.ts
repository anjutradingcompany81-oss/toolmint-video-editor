// Pure audio-feature helpers for the AI Repetitive Voice Remover's "audio
// fingerprint similarity" and "waveform matching" signals. Operates on
// plain mono PCM float samples (same decode path media-probe.service.ts
// already uses for waveform peaks) so it needs no ffmpeg process itself —
// callers extract PCM once and pass it in here.
import Meyda from "meyda";

const MFCC_FRAME_SIZE = 512; // must be a power of 2 for meyda's FFT
const MFCC_COEFFICIENTS = 13;

// Averages per-frame MFCCs across a whole segment into one fixed-length
// vector — a compact "audio fingerprint" that two segments of different
// exact lengths can still be compared by (cosine similarity doesn't
// require equal-length inputs beyond matching dimensionality, which a
// fixed coefficient count guarantees regardless of segment duration).
export function computeMfccFingerprint(samples: Float32Array, sampleRate: number): number[] {
  Meyda.sampleRate = sampleRate;
  Meyda.bufferSize = MFCC_FRAME_SIZE;
  Meyda.numberOfMFCCCoefficients = MFCC_COEFFICIENTS;

  const frameCount = Math.floor(samples.length / MFCC_FRAME_SIZE);
  if (frameCount === 0) return new Array(MFCC_COEFFICIENTS).fill(0);

  const sum = new Array(MFCC_COEFFICIENTS).fill(0);
  for (let f = 0; f < frameCount; f++) {
    const frame = samples.subarray(f * MFCC_FRAME_SIZE, (f + 1) * MFCC_FRAME_SIZE);
    const mfcc = Meyda.extract("mfcc", frame) as number[] | null;
    if (!mfcc) continue;
    for (let i = 0; i < MFCC_COEFFICIENTS; i++) sum[i] += mfcc[i];
  }
  return sum.map((v) => v / frameCount);
}

// 1 = identical spectral shape, -1 = opposite, 0 = unrelated — the
// standard similarity measure for fixed-length feature vectors like MFCCs.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Normalizes an MFCC cosine similarity (roughly -1..1 in practice, but
// dominated by the sign/scale of the first coefficient) into a clean 0..1
// "audio similarity" score for the detector/confidence math to consume.
export function audioSimilarityFromFingerprints(a: number[], b: number[]): number {
  return Math.max(0, Math.min(1, (cosineSimilarity(a, b) + 1) / 2));
}

// Waveform cross-correlation: how well two envelope shapes line up when
// slid against each other, independent of small timing offsets — this is
// what specifically catches "the exact same take, played twice" (a clip
// overlap or a render duplication bug), which two independently-spoken
// repeats of a line won't reproduce with this much shape fidelity even
// when the words and general spectral tone match. `envelopeA`/`envelopeB`
// are expected to already be reduced to a fixed number of energy buckets
// (see MediaProbeService's waveform peaks — this reuses the same idea).
export function waveformCorrelation(envelopeA: number[], envelopeB: number[]): number {
  const n = Math.min(envelopeA.length, envelopeB.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += envelopeA[i] * envelopeB[i];
    normA += envelopeA[i] * envelopeA[i];
    normB += envelopeB[i] * envelopeB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

const MIN_PITCH_HZ = 70;
const MAX_PITCH_HZ = 400;

// Autocorrelation-based fundamental-frequency (pitch) estimate, averaged
// over the whole segment. This is deliberately a *separate* signal from
// the MFCC fingerprint above: MFCCs capture spectral envelope shape,
// which is dominated by *phonetic content* (what vowel/consonant is being
// said) — two different speakers saying the exact same words can end up
// with a surprisingly similar averaged MFCC despite sounding nothing
// alike, confirmed live (a male and female voice reading the identical
// sentence scored 0.99 MFCC-cosine similarity). Pitch is far more
// speaker-discriminative, especially across a gender difference (~100Hz
// vs ~190Hz in that same live test) — see confidence-scoring in
// repetition-detector.util.ts for how the two signals are combined.
// Returns 0 when no clear periodicity is found (silence, noise, or a
// segment too short to estimate reliably).
export function estimatePitchHz(samples: Float32Array, sampleRate: number): number {
  const minLag = Math.floor(sampleRate / MAX_PITCH_HZ);
  const maxLag = Math.floor(sampleRate / MIN_PITCH_HZ);
  if (samples.length <= maxLag) return 0;

  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < samples.length - lag; i++) corr += samples[i] * samples[i + lag];
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  return bestLag > 0 ? sampleRate / bestLag : 0;
}

// Reduces raw PCM samples to a small, fixed-size energy envelope (RMS per
// bucket) — the same "shape, not exact sample values" representation
// waveformCorrelation compares, robust to the two segments having slightly
// different lengths (accidental repeats are rarely frame-identical in
// duration even when they're the same words).
export function computeEnergyEnvelope(samples: Float32Array, buckets = 40): number[] {
  if (samples.length === 0) return new Array(buckets).fill(0);
  const perBucket = Math.max(1, Math.floor(samples.length / buckets));
  const envelope: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * perBucket;
    const end = b === buckets - 1 ? samples.length : start + perBucket;
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
      count++;
    }
    envelope.push(count > 0 ? Math.sqrt(sumSq / count) : 0);
  }
  return envelope;
}

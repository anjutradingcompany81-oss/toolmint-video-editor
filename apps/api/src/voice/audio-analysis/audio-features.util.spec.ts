import { audioSimilarityFromFingerprints, computeEnergyEnvelope, computeMfccFingerprint, cosineSimilarity, estimatePitchHz, waveformCorrelation } from "./audio-features.util";

function tone(freqHz: number, sampleRate: number, durationS: number, amplitude = 0.5): Float32Array {
  const n = Math.round(sampleRate * durationS);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return samples;
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 when dimensions mismatch or a vector is all-zero", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("audioSimilarityFromFingerprints", () => {
  it("maps identical fingerprints to 1", () => {
    expect(audioSimilarityFromFingerprints([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("clamps into 0..1 even for negative cosine similarity", () => {
    const result = audioSimilarityFromFingerprints([1, 1], [-1, -1]);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe("computeMfccFingerprint", () => {
  it("produces a 13-coefficient vector", () => {
    const fingerprint = computeMfccFingerprint(tone(440, 16000, 1), 16000);
    expect(fingerprint).toHaveLength(13);
  });

  it("gives the same tone a near-identical fingerprint to itself", () => {
    const a = computeMfccFingerprint(tone(440, 16000, 1), 16000);
    const b = computeMfccFingerprint(tone(440, 16000, 1), 16000);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  });

  it("gives clearly different tones a lower similarity than identical tones", () => {
    const low = computeMfccFingerprint(tone(220, 16000, 1), 16000);
    const high = computeMfccFingerprint(tone(3000, 16000, 1), 16000);
    const same = computeMfccFingerprint(tone(220, 16000, 1), 16000);
    expect(cosineSimilarity(low, same)).toBeGreaterThan(cosineSimilarity(low, high));
  });

  it("returns a zero vector rather than throwing for near-empty input", () => {
    expect(computeMfccFingerprint(new Float32Array(10), 16000)).toEqual(new Array(13).fill(0));
  });
});

describe("computeEnergyEnvelope", () => {
  it("produces the requested number of buckets", () => {
    expect(computeEnergyEnvelope(tone(440, 16000, 1), 20)).toHaveLength(20);
  });

  it("is near-zero for silence and positive for a real tone", () => {
    const silence = computeEnergyEnvelope(new Float32Array(16000), 10);
    const loud = computeEnergyEnvelope(tone(440, 16000, 1, 0.8), 10);
    expect(silence.every((v) => v === 0)).toBe(true);
    expect(loud.every((v) => v > 0)).toBe(true);
  });

  it("handles empty input without throwing", () => {
    expect(computeEnergyEnvelope(new Float32Array(0), 10)).toHaveLength(10);
  });
});

describe("estimatePitchHz", () => {
  it("estimates a 150Hz tone within a small tolerance", () => {
    const pitch = estimatePitchHz(tone(150, 16000, 0.5), 16000);
    expect(pitch).toBeGreaterThan(140);
    expect(pitch).toBeLessThan(160);
  });

  it("estimates a 250Hz tone within a small tolerance", () => {
    const pitch = estimatePitchHz(tone(250, 16000, 0.5), 16000);
    expect(pitch).toBeGreaterThan(235);
    expect(pitch).toBeLessThan(265);
  });

  it("clearly distinguishes a low-pitched tone from a high-pitched one", () => {
    const low = estimatePitchHz(tone(100, 16000, 0.5), 16000);
    const high = estimatePitchHz(tone(200, 16000, 0.5), 16000);
    expect(high).toBeGreaterThan(low * 1.5);
  });

  it("returns 0 for silence or a too-short segment rather than throwing", () => {
    expect(estimatePitchHz(new Float32Array(16000).fill(0), 16000)).toBe(0);
    expect(estimatePitchHz(new Float32Array(10), 16000)).toBe(0);
  });
});

describe("waveformCorrelation", () => {
  it("is high for the same envelope compared to itself", () => {
    const env = computeEnergyEnvelope(tone(440, 16000, 1, 0.6), 40);
    expect(waveformCorrelation(env, env)).toBeGreaterThan(0.99);
  });

  it("is lower for a rising-then-quiet envelope vs. a flat-loud one", () => {
    const flat = [1, 1, 1, 1, 1];
    const rampDown = [1, 0.8, 0.4, 0.1, 0];
    expect(waveformCorrelation(flat, flat)).toBeGreaterThan(waveformCorrelation(flat, rampDown));
  });

  it("handles empty envelopes without throwing", () => {
    expect(waveformCorrelation([], [])).toBe(0);
  });
});

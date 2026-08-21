import { detectRepetitions, SENSITIVITY_PRESETS, type TranscriptSegment } from "./repetition-detector.util";

// Bit-identical fingerprint — reserved for cases meant to represent
// literally the same audio samples (a render/clip-overlap duplication).
const IDENTICAL_FINGERPRINT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
// Two distinct-but-comparable fingerprints (pairwise audioSimilarity
// ~0.77 — comfortably clears BALANCED/HIGH's audio thresholds but sits
// well below the 0.97 "literally the same samples" cutoff) standing in
// for the natural voice variance between two independently-spoken takes
// of the same line. `segment()` alternates between them below so any two
// segments built back-to-back (the normal way these fixtures are used)
// automatically get two *different* fingerprints instead of comparing an
// array to itself — comparing the same array reference would trivially
// score 1.0 and misclassify every plain repeat as RENDER_DUPLICATE.
const TAKE_FINGERPRINTS = [
  [13, 1, 10, 2, 7, 12, 3, 9, 5, 11, 1, 8, 2],
  [2, 11, 4, 9, 1, 6, 13, 3, 10, 5, 12, 7, 1],
];
// Meaningfully more different again — a poor/noisy match, ~0.78 similarity
// vs a *clean* reference (not vs. the other TAKE_FINGERPRINTS entry).
const NOISY_FINGERPRINT = [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const FLAT_ENVELOPE = new Array(40).fill(0.5);

let takeFingerprintCounter = 0;

function segment(overrides: Partial<TranscriptSegment> & Pick<TranscriptSegment, "startMs" | "endMs" | "text">): TranscriptSegment {
  return {
    id: `${overrides.startMs}-${overrides.endMs}`,
    trackId: "track_1",
    clipId: "clip_1",
    mediaAssetId: "asset_1",
    sourceStartMs: overrides.startMs,
    sourceEndMs: overrides.endMs,
    audioFingerprint: TAKE_FINGERPRINTS[takeFingerprintCounter++ % TAKE_FINGERPRINTS.length],
    waveformEnvelope: FLAT_ENVELOPE,
    pitchHz: 150, // same default pitch for both sides unless a test overrides it — same speaker, by default
    ...overrides,
  };
}

describe("detectRepetitions", () => {
  it("flags a sentence accidentally repeated twice, close together, as high confidence", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "I will meet you at the station" }),
      segment({ startMs: 2200, endMs: 4200, text: "I will meet you at the station" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].confidenceBucket).toBe("HIGH");
    expect(results[0].suggestedMode).toBe("AUDIO_ONLY");
  });

  it("flags one word repeated (a stutter/glitch), classified as WORD", () => {
    const segments = [segment({ startMs: 0, endMs: 400, text: "okay" }), segment({ startMs: 450, endMs: 850, text: "okay" })];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("WORD");
  });

  it("classifies duplicate speech straddling two joined clips, close together, as SCENE_JOIN", () => {
    const segments = [
      segment({ startMs: 0, endMs: 3000, text: "let's head to the car now", clipId: "clip_a" }),
      segment({ startMs: 3050, endMs: 6050, text: "let's head to the car now", clipId: "clip_b" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results[0].kind).toBe("SCENE_JOIN");
  });

  it("classifies the same repeat as a plain SENTENCE (not SCENE_JOIN) when it's within one continuous clip", () => {
    const segments = [
      segment({ startMs: 0, endMs: 3000, text: "let's head to the car now", clipId: "clip_a" }),
      segment({ startMs: 3050, endMs: 6050, text: "let's head to the car now", clipId: "clip_a" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results[0].kind).toBe("SENTENCE");
  });

  it("classifies two segments that literally overlap in time on the same track as CLIP_OVERLAP, forcing a trim", () => {
    const segments = [
      segment({ startMs: 0, endMs: 3000, text: "watch out for the car" }),
      segment({ startMs: 2000, endMs: 5000, text: "watch out for the car" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results[0].kind).toBe("CLIP_OVERLAP");
    expect(results[0].suggestedMode).toBe("AUDIO_VIDEO_TRIM");
  });

  it("classifies a near-identical waveform match (literally the same audio samples) as RENDER_DUPLICATE", () => {
    const segments = [
      segment({ startMs: 0, endMs: 3000, text: "please hold the door", audioFingerprint: IDENTICAL_FINGERPRINT, waveformEnvelope: FLAT_ENVELOPE }),
      segment({
        startMs: 10_000,
        endMs: 13_000,
        text: "please hold the door",
        audioFingerprint: IDENTICAL_FINGERPRINT,
        waveformEnvelope: FLAT_ENVELOPE,
      }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results[0].kind).toBe("RENDER_DUPLICATE");
    expect(results[0].suggestedMode).toBe("AUDIO_VIDEO_TRIM");
  });

  it("does NOT flag the same line spoken by two different characters — that's dialogue, not a mistake", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "I can't believe this is happening", speakerLabel: "SPEAKER_A" }),
      segment({ startMs: 2200, endMs: 4200, text: "I can't believe this is happening", speakerLabel: "SPEAKER_B" }),
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("caps confidence below HIGH for the same line in two clearly different pitches, even when diarization gave no speaker labels", () => {
    // Reproduces a real false positive found in live testing: a male
    // voice (~102Hz) and a female voice (~188Hz) reading the identical
    // sentence scored 0.99 on MFCC/audio-fingerprint similarity alone —
    // without diarization (no HUGGINGFACE_TOKEN configured, or it simply
    // failed), speakerLabel is undefined for both, so the speaker-label
    // check above can't protect this case. Pitch is the fallback signal.
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "I can't believe this is happening right now", pitchHz: 102, audioFingerprint: IDENTICAL_FINGERPRINT }),
      segment({
        startMs: 2200,
        endMs: 4200,
        text: "I can't believe this is happening right now",
        pitchHz: 188,
        audioFingerprint: IDENTICAL_FINGERPRINT,
      }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.HIGH);
    expect(results).toHaveLength(1); // still surfaced for manual review — pitch is an inferred signal, not a certainty
    expect(results[0].confidenceBucket).not.toBe("HIGH");
  });

  it("does not cap confidence for a genuine same-speaker repeat with ordinary pitch variation between takes", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "meet me at the entrance", pitchHz: 150 }),
      segment({ startMs: 2200, endMs: 4200, text: "meet me at the entrance", pitchHz: 162 }), // ~8% variation, well under the 20% cutoff
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results[0].confidenceBucket).toBe("HIGH");
  });

  it("does NOT flag similar dialogue that recurs across distant, unrelated scenes (beyond the max gap)", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "everything is going to be fine" }),
      segment({ startMs: 400_000, endMs: 402_000, text: "everything is going to be fine" }), // ~6.5 minutes later
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("caps confidence below HIGH for a line repeated 3+ times (a song chorus / catchphrase), protecting intentional repetition from auto-apply", () => {
    const chorus = "we will we will rock you";
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: chorus }),
      segment({ startMs: 2100, endMs: 4100, text: chorus }),
      segment({ startMs: 4200, endMs: 6200, text: chorus }),
      segment({ startMs: 6300, endMs: 8300, text: chorus }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.confidenceBucket).not.toBe("HIGH");
  });

  it("still surfaces a 2x-only accidental duplicate as HIGH even when other, unrelated lines repeat 3+ times elsewhere", () => {
    const chorus = "la la la la la";
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: chorus }),
      segment({ startMs: 2100, endMs: 4100, text: chorus }),
      segment({ startMs: 4200, endMs: 6200, text: chorus }),
      segment({ startMs: 10_000, endMs: 12_000, text: "turn left at the next light" }),
      segment({ startMs: 12_100, endMs: 14_100, text: "turn left at the next light" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    const accidental = results.find((r) => r.original.text === "turn left at the next light");
    expect(accidental?.confidenceBucket).toBe("HIGH");
  });

  it("scores dramatic repetition (same word, different delivery/audio) lower than a mechanical duplicate", () => {
    // Same text ("no no no" said with emphasis) but each utterance has a
    // meaningfully different vocal delivery, unlike an accidental replay
    // of the exact same take.
    const dramatic = [
      segment({ startMs: 0, endMs: 300, text: "no", audioFingerprint: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }),
      segment({ startMs: 350, endMs: 650, text: "no", audioFingerprint: [3, 5, 1, 8, 2, 9, 4, 7, 6, 1, 8, 2, 5] }),
    ];
    const mechanical = [
      segment({ startMs: 0, endMs: 300, text: "no", audioFingerprint: IDENTICAL_FINGERPRINT }),
      segment({ startMs: 350, endMs: 650, text: "no", audioFingerprint: IDENTICAL_FINGERPRINT }),
    ];
    const [dramaticResult] = detectRepetitions(dramatic, SENSITIVITY_PRESETS.HIGH);
    const [mechanicalResult] = detectRepetitions(mechanical, SENSITIVITY_PRESETS.HIGH);
    expect(mechanicalResult.confidenceScore).toBeGreaterThan(dramaticResult?.confidenceScore ?? 1);
  });

  it("still detects a duplicate with a lower-fidelity match under noisy audio (HIGH sensitivity), just at lower confidence", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "meet me by the entrance", audioFingerprint: IDENTICAL_FINGERPRINT }),
      segment({ startMs: 2200, endMs: 4200, text: "meet me by the entrance", audioFingerprint: NOISY_FINGERPRINT }),
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.LOW)).toHaveLength(0); // too strict for a noisy match
    const highSensitivity = detectRepetitions(segments, SENSITIVITY_PRESETS.HIGH);
    expect(highSensitivity).toHaveLength(1);
  });

  it("does not flag two clearly different sentences", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "please close the door behind you" }),
      segment({ startMs: 2200, endMs: 4200, text: "can you bring the car around front" }),
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("ignores segments shorter than the minimum segment duration", () => {
    const segments = [segment({ startMs: 0, endMs: 50, text: "hi" }), segment({ startMs: 100, endMs: 150, text: "hi" })];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("collapses a long back-to-back hallucinated-phrase run into ONE result instead of every pairwise combination", () => {
    // Reproduces a real bug found live: Whisper hallucinated the same
    // short garbage phrase repeatedly over ~22s of silent/noisy audio,
    // producing 8 near-identical adjacent segments. A naive pairwise scan
    // flags C(8,2) = 28 "repetitions" — nearly the whole scan result set
    // for one problem — instead of the single contiguous run a person
    // would actually want to review and fix in one move.
    const phrase = "पुव ।";
    const segments = Array.from({ length: 8 }, (_, i) => segment({ startMs: i * 700, endMs: i * 700 + 500, text: phrase }));
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].original.startMs).toBe(0);
    expect(results[0].repeated.startMs).toBe(4900); // spans through the last occurrence in the run
    expect(results[0].confidenceBucket).not.toBe("HIGH"); // 8x repetition — an intentional/looping refrain, not a 2x accident
  });

  it("does NOT flood results with a common short word spoken naturally throughout a scene (only near-adjacent repeats of a short word are real mistakes)", () => {
    // "hai" recurring every ~5s across ordinary speech is completely
    // normal Hindi grammar, not an accidental duplicate — reproduces the
    // real-world flooding bug where a full-length video's routine reuse
    // of short function words got flagged dozens of times. Each
    // occurrence gets its own distinct fingerprint (all pairwise below
    // the 0.97 render-duplicate cutoff, confirmed) — four genuinely
    // separate utterances of the same common word, not four copies of one
    // recording.
    const segments = [
      segment({ startMs: 0, endMs: 400, text: "hai", audioFingerprint: [13, 1, 10, 2, 7, 12, 3, 9, 5, 11, 1, 8, 2] }),
      segment({ startMs: 5000, endMs: 5400, text: "hai", audioFingerprint: [2, 11, 4, 9, 1, 6, 13, 3, 10, 5, 12, 7, 1] }),
      segment({ startMs: 10_000, endMs: 10_400, text: "hai", audioFingerprint: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] }),
      segment({ startMs: 15_000, endMs: 15_400, text: "hai", audioFingerprint: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }),
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("still flags a genuinely stuttered short word repeated immediately, even though a wide-gap match for the same word would be noise", () => {
    const segments = [segment({ startMs: 0, endMs: 400, text: "hai" }), segment({ startMs: 500, endMs: 900, text: "hai" })];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("WORD");
  });

  it("caps a short phrase's match window tighter than the full sentence gap, so an unrelated later reuse of a common short phrase isn't flagged", () => {
    // "zyada hoti" (2 words) said once, then an unrelated later reuse of
    // the same short phrase 10s on is ordinary speech, not a mistake —
    // even though 10s is well inside BALANCED's 15s sentence-level gap.
    const segments = [
      segment({ startMs: 0, endMs: 900, text: "zyada hoti" }),
      segment({ startMs: 10_000, endMs: 10_900, text: "zyada hoti" }),
    ];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("handles a long multi-scene video without pairing segments that are each valid on their own but too far apart from each other", () => {
    const segments = [
      segment({ startMs: 0, endMs: 2000, text: "scene one dialogue line" }),
      segment({ startMs: 60_000, endMs: 62_000, text: "scene two dialogue line" }),
      segment({ startMs: 61_800, endMs: 63_800, text: "scene two dialogue line" }), // real accidental dupe, close together
      segment({ startMs: 600_000, endMs: 602_000, text: "scene ten dialogue line" }),
    ];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].original.text).toBe("scene two dialogue line");
  });
});

// The five acceptance cases the product owner specified for repetition
// detection, written exactly as stated so a regression in any of them
// fails loudly and by name. These exercise the same detectRepetitions used
// in production; the segment fixtures stand in for what Whisper + the
// audio fingerprinter hand it for each utterance.
import { detectRepetitions, SENSITIVITY_PRESETS, type TranscriptSegment } from "./repetition-detector.util";

// Two distinct-but-comparable fingerprints, alternated so consecutive
// segments never compare an array against itself (which would score a
// perfect 1.0 and be misread as literally duplicated audio samples).
const TAKE_FINGERPRINTS = [
  [13, 1, 10, 2, 7, 12, 3, 9, 5, 11, 1, 8, 2],
  [2, 11, 4, 9, 1, 6, 13, 3, 10, 5, 12, 7, 1],
];
const FLAT_ENVELOPE = new Array(40).fill(0.5);
let counter = 0;

function seg(startMs: number, endMs: number, text: string): TranscriptSegment {
  return {
    id: `${startMs}-${endMs}`,
    trackId: "track_1",
    clipId: "clip_1",
    mediaAssetId: "asset_1",
    startMs,
    endMs,
    sourceStartMs: startMs,
    sourceEndMs: endMs,
    text,
    audioFingerprint: TAKE_FINGERPRINTS[counter++ % TAKE_FINGERPRINTS.length],
    waveformEnvelope: FLAT_ENVELOPE,
    pitchHz: 150,
  };
}

describe("mandatory repetition-detection acceptance cases", () => {
  it("case 1: flags only the second मैं in 'मैं मैं कल ऑफिस जाऊँगा।'", () => {
    // Whisper emits word/phrase-level segments; the stutter is the repeated
    // leading word, immediately adjacent.
    const segments = [seg(0, 500, "मैं"), seg(520, 1020, "मैं"), seg(1100, 3000, "कल ऑफिस जाऊँगा")];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("WORD");
    // The flagged (removable) side must be the SECOND occurrence, never the first.
    expect(results[0].repeated.startMs).toBe(520);
    expect(results[0].original.startMs).toBe(0);
  });

  it("case 2: flags only the second complete sentence when it is said twice", () => {
    const line = "हम कल बैठक करेंगे";
    const segments = [seg(0, 2200, line), seg(2400, 4600, line)];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("SENTENCE");
    expect(results[0].repeated.startMs).toBe(2400);
  });

  it("case 3: reports nothing for 'आज बैठक है। कल भी बैठक है।' — different sentences that share a word", () => {
    const segments = [seg(0, 1800, "आज बैठक है"), seg(2000, 4000, "कल भी बैठक है")];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("case 4: flags the second 'This is the final report.'", () => {
    const line = "This is the final report";
    const segments = [seg(0, 2000, line), seg(2200, 4200, line)];
    const results = detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("SENTENCE");
    expect(results[0].repeated.startMs).toBe(2200);
  });

  it("case 5: reports nothing for one long sentence that reuses a word ('section ... section')", () => {
    const segments = [seg(0, 5000, "This report contains multiple sections and the final section contains results")];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });

  it("does not flag deliberate emphasis like 'बहुत बहुत धन्यवाद' as an error at default sensitivity", () => {
    // Intentional doubling for emphasis, spoken as one continuous phrase —
    // must not be reported as an accidental duplicate the user has to dismiss.
    const segments = [seg(0, 2400, "बहुत बहुत धन्यवाद")];
    expect(detectRepetitions(segments, SENSITIVITY_PRESETS.BALANCED)).toHaveLength(0);
  });
});

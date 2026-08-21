import { speakerForRange, type DiarizationSegment } from "./diarization.service";

describe("speakerForRange", () => {
  const segments: DiarizationSegment[] = [
    { startMs: 0, endMs: 2000, speaker: "SPEAKER_00" },
    { startMs: 2000, endMs: 5000, speaker: "SPEAKER_01" },
  ];

  it("returns the speaker whose turn fully covers the range", () => {
    expect(speakerForRange(segments, 500, 1500)).toBe("SPEAKER_00");
  });

  it("returns the speaker with the largest overlap when a range straddles two turns", () => {
    // 1800-2600: 200ms in SPEAKER_00's turn, 600ms in SPEAKER_01's.
    expect(speakerForRange(segments, 1800, 2600)).toBe("SPEAKER_01");
  });

  it("returns undefined when nothing overlaps (a gap, or empty diarization)", () => {
    expect(speakerForRange(segments, 6000, 7000)).toBeUndefined();
    expect(speakerForRange([], 0, 1000)).toBeUndefined();
  });
});

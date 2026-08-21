import { parseSilenceWindows, speechRegionsFromSilence } from "./voice-activity.util";

describe("parseSilenceWindows", () => {
  it("parses matched start/end pairs from ffmpeg's silencedetect stderr", () => {
    const stderr = `
      [silencedetect @ 0x1] silence_start: 1.5
      [silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25
      [silencedetect @ 0x1] silence_start: 8.2
      [silencedetect @ 0x1] silence_end: 9.0 | silence_duration: 0.8
    `;
    expect(parseSilenceWindows(stderr)).toEqual([
      { startMs: 1500, endMs: 2750 },
      { startMs: 8200, endMs: 9000 },
    ]);
  });

  it("returns nothing for text with no silence markers", () => {
    expect(parseSilenceWindows("frame= 100 fps=30")).toEqual([]);
  });
});

describe("speechRegionsFromSilence", () => {
  it("returns the whole duration as one speech region when there's no silence at all", () => {
    expect(speechRegionsFromSilence([], 10_000)).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it("carves speech regions out around silence windows", () => {
    const result = speechRegionsFromSilence([{ startMs: 2000, endMs: 4000 }], 10_000);
    expect(result).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 10_000 },
    ]);
  });

  it("merges speech regions separated by a gap shorter than minGapMs", () => {
    // Silence 2000-2200 (200ms) is shorter than the 300ms default minGap.
    const result = speechRegionsFromSilence([{ startMs: 2000, endMs: 2200 }], 10_000);
    expect(result).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it("does not merge speech regions separated by a gap at/above minGapMs", () => {
    const result = speechRegionsFromSilence([{ startMs: 2000, endMs: 2500 }], 10_000, 300);
    expect(result).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 2500, endMs: 10_000 },
    ]);
  });

  it("handles silence starting at 0 or extending to the very end", () => {
    const result = speechRegionsFromSilence(
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 9000, endMs: 10_000 },
      ],
      10_000,
    );
    expect(result).toEqual([{ startMs: 1000, endMs: 9000 }]);
  });

  it("handles a video that is silence from start to end", () => {
    expect(speechRegionsFromSilence([{ startMs: 0, endMs: 10_000 }], 10_000)).toEqual([]);
  });
});

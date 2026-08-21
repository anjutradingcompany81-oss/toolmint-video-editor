import { pickDetectionWindows, pickDominantLanguage } from "./language-detect.util";

describe("pickDetectionWindows", () => {
  it("returns a single full-coverage window for audio shorter than one window", () => {
    expect(pickDetectionWindows(5000, 10)).toEqual([{ startMs: 0, endMs: 5000 }]);
  });

  it("spreads multiple windows across a long file", () => {
    const windows = pickDetectionWindows(250_000, 10, 4);
    expect(windows).toHaveLength(4);
    // Every window stays fully inside the audio.
    for (const w of windows) {
      expect(w.startMs).toBeGreaterThanOrEqual(0);
      expect(w.endMs).toBeLessThanOrEqual(250_000);
      expect(w.endMs - w.startMs).toBe(10_000);
    }
    // Windows are spread out, not clustered at the start.
    expect(windows[windows.length - 1].startMs).toBeGreaterThan(windows[0].startMs + 50_000);
  });

  it("never exceeds maxWindows even for a very long file", () => {
    expect(pickDetectionWindows(3_600_000, 10, 4)).toHaveLength(4);
  });

  it("uses fewer windows than maxWindows for a moderately short file", () => {
    // 25s of audio, 10s windows -> only 2 whole windows fit.
    const windows = pickDetectionWindows(25_000, 10, 4);
    expect(windows.length).toBeLessThanOrEqual(2);
  });
});

describe("pickDominantLanguage", () => {
  it("picks english when its score is clearly highest", () => {
    expect(pickDominantLanguage({ "<|en|>": 15, "<|hi|>": 5, "<|ur|>": 4 })).toBe("english");
  });

  it("picks hindi when its score is clearly highest", () => {
    expect(pickDominantLanguage({ "<|en|>": 5, "<|hi|>": 15, "<|ur|>": 4 })).toBe("hindi");
  });

  it("folds the Urdu token into the Hindi family, since Whisper sometimes represents Hindi speech that way", () => {
    expect(pickDominantLanguage({ "<|en|>": 10, "<|hi|>": 2, "<|ur|>": 15 })).toBe("hindi");
  });

  it("ignores other languages entirely when deciding between english and hindi", () => {
    expect(pickDominantLanguage({ "<|en|>": 5, "<|hi|>": 6, "<|de|>": 100, "<|fr|>": 90 })).toBe("hindi");
  });

  it("defaults to english on an exact tie", () => {
    expect(pickDominantLanguage({ "<|en|>": 10, "<|hi|>": 10 })).toBe("english");
  });

  it("handles a completely empty score map without throwing", () => {
    expect(pickDominantLanguage({})).toBe("english");
  });
});

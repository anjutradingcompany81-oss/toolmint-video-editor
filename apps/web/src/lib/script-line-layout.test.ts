import { describe, it, expect } from "vitest";
import { layoutScriptLines } from "./script-line-layout";

describe("layoutScriptLines", () => {
  it("returns an empty array for no lines", () => {
    expect(layoutScriptLines([], 10_000)).toEqual([]);
  });

  it("gives a single line the whole duration", () => {
    const result = layoutScriptLines(["Hello there."], 5000);
    expect(result).toEqual([{ text: "Hello there.", startMs: 0, durationMs: 5000 }]);
  });

  it("splits two equal-length lines evenly", () => {
    const result = layoutScriptLines(["one two three", "four five six"], 6000);
    expect(result[0]).toEqual({ text: "one two three", startMs: 0, durationMs: 3000 });
    expect(result[1]).toEqual({ text: "four five six", startMs: 3000, durationMs: 3000 });
  });

  it("gives a longer line proportionally more time than a short one", () => {
    const result = layoutScriptLines(["Okay.", "This is a much longer sentence with many more words in it."], 10_000);
    expect(result[1].durationMs).toBeGreaterThan(result[0].durationMs);
    // Roughly 1 word vs 11 words — the long line should dominate the split.
    expect(result[1].durationMs).toBeGreaterThan(8000);
  });

  it("lines are laid back-to-back with no gaps or overlaps", () => {
    const result = layoutScriptLines(["a", "bb ccc", "dddd eeee ffff"], 9000);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].startMs).toBe(result[i - 1].startMs + result[i - 1].durationMs);
    }
  });

  it("the lines exactly fill the target duration, absorbing rounding in the last line", () => {
    const result = layoutScriptLines(["one", "two", "three"], 10_000);
    const last = result[result.length - 1];
    expect(last.startMs + last.durationMs).toBe(10_000);
  });

  it("never produces a zero or negative duration even for a very short target", () => {
    const result = layoutScriptLines(["a", "b", "c"], 2);
    for (const line of result) {
      expect(line.durationMs).toBeGreaterThan(0);
    }
  });

  it("treats a target duration of zero as at least 1ms rather than producing NaN", () => {
    const result = layoutScriptLines(["hello"], 0);
    expect(result[0].durationMs).toBeGreaterThan(0);
    expect(Number.isFinite(result[0].durationMs)).toBe(true);
  });
});

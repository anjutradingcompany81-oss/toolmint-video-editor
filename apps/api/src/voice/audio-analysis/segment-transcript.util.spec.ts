import { groupWordsIntoSegments, splitOnImmediateRepeats } from "./segment-transcript.util";

function w(text: string, startMs: number, endMs: number) {
  return { text, startMs, endMs };
}

describe("groupWordsIntoSegments", () => {
  it("returns nothing for no words", () => {
    expect(groupWordsIntoSegments([])).toEqual([]);
  });

  it("keeps closely-spoken words in one segment", () => {
    const words = [w(" I", 0, 200), w(" will", 210, 400), w(" go", 410, 600)];
    const segments = groupWordsIntoSegments(words);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ text: "I will go", startMs: 0, endMs: 600 });
  });

  it("splits into a new segment after a long pause", () => {
    const words = [w(" Okay", 0, 300), w(" So", 2000, 2300), w(" anyway", 2310, 2600)];
    const segments = groupWordsIntoSegments(words, 700);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Okay");
    expect(segments[1].text).toBe("So anyway");
  });

  it("splits at a sentence-ending punctuation mark even without a long pause", () => {
    const words = [w(" Yes.", 0, 300), w(" Really", 350, 600)];
    const segments = groupWordsIntoSegments(words, 700);
    expect(segments).toHaveLength(2);
  });

  it("splits at a Hindi sentence-ending danda (।)", () => {
    const words = [w(" ठीक है।", 0, 300), w(" चलिए", 350, 600)];
    const segments = groupWordsIntoSegments(words, 700);
    expect(segments).toHaveLength(2);
  });

  it("collapses whitespace from Whisper's leading-space word tokens", () => {
    const words = [w(" Hello", 0, 200), w(" there", 210, 400)];
    expect(groupWordsIntoSegments(words)[0].text).toBe("Hello there");
  });

  it("splits a phrase repeated within one breath (no pause) into two directly-comparable segments", () => {
    // Reproduces a real bug: "...raajneeti zyada hoti zyada hoti" transcribed
    // correctly as one continuous phrase (no pause between the repeat),
    // which the pause-based grouping alone would leave as a single segment
    // the pairwise detector could never compare against anything.
    const words = [
      w(" kaam", 0, 200),
      w(" aur", 210, 400),
      w(" raajneeti", 410, 700),
      w(" zyada", 710, 900),
      w(" hoti", 910, 1100),
      w(" zyada", 1110, 1300),
      w(" hoti", 1310, 1500),
    ];
    const segments = groupWordsIntoSegments(words);
    expect(segments).toHaveLength(3);
    expect(segments[0].text).toBe("kaam aur raajneeti");
    expect(segments[1].text).toBe("zyada hoti");
    expect(segments[2].text).toBe("zyada hoti");
    expect(segments[1].text).toBe(segments[2].text);
  });
});

describe("splitOnImmediateRepeats", () => {
  it("leaves a segment with no repeat untouched", () => {
    const words = [w("we", 0, 100), w("need", 100, 200), w("to", 200, 300), w("leave", 300, 400)];
    expect(splitOnImmediateRepeats(words)).toEqual([words]);
  });

  it("splits a single repeated word (a stutter) into two one-word groups", () => {
    const words = [w("please", 0, 100), w("please", 100, 200), w("stop", 200, 300)];
    const groups = splitOnImmediateRepeats(words);
    expect(groups).toEqual([[words[0]], [words[1]], [words[2]]]);
  });

  it("prefers the longest repeated phrase over a shorter coincidental match", () => {
    // "zyada hoti zyada hoti" — the 2-word phrase repeats, not just "hoti" alone.
    const words = ["zyada", "hoti", "zyada", "hoti"].map((t, i) => w(t, i * 100, i * 100 + 100));
    const groups = splitOnImmediateRepeats(words);
    expect(groups).toEqual([
      [words[0], words[1]],
      [words[2], words[3]],
    ]);
  });

  it("is case-insensitive and punctuation-insensitive when matching", () => {
    const words = [w("Zyada", 0, 100), w("Hoti.", 100, 200), w("zyada", 200, 300), w("hoti", 300, 400)];
    const groups = splitOnImmediateRepeats(words);
    expect(groups).toHaveLength(2);
  });

  it("keeps context before and after the repeat as their own group(s)", () => {
    const words = ["the", "cat", "sat", "sat", "on", "the", "mat"].map((t, i) => w(t, i * 100, i * 100 + 100));
    const groups = splitOnImmediateRepeats(words);
    expect(groups.map((g) => g.map((w) => w.text))).toEqual([["the", "cat"], ["sat"], ["sat"], ["on", "the", "mat"]]);
  });

  it("does not treat two different words as a repeat", () => {
    const words = [w("turn", 0, 100), w("left", 100, 200), w("turn", 200, 300), w("right", 300, 400)];
    expect(splitOnImmediateRepeats(words)).toEqual([words]);
  });
});

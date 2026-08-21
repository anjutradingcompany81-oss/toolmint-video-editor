import { charSimilarity, levenshteinDistance, normalizeForComparison, textSimilarity, tokenSimilarity } from "./text-similarity.util";

describe("normalizeForComparison", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeForComparison("Hello,   World!!")).toBe("hello world");
  });

  it("preserves non-Latin scripts (Devanagari) untouched aside from case/punctuation rules", () => {
    expect(normalizeForComparison("नमस्ते, दुनिया!")).toBe("नमस्ते दुनिया");
  });
});

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });

  it("counts a single substitution as distance 1", () => {
    expect(levenshteinDistance("cat", "bat")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });
});

describe("charSimilarity", () => {
  it("is 1 for identical text", () => {
    expect(charSimilarity("we need to leave now", "we need to leave now")).toBe(1);
  });

  it("is 1 for text differing only in case/punctuation", () => {
    expect(charSimilarity("We need to leave now.", "we need to leave now")).toBe(1);
  });

  it("is low for unrelated sentences", () => {
    expect(charSimilarity("we need to leave now", "the weather is nice today")).toBeLessThan(0.5);
  });

  it("handles mixed Hindi-English (code-switched) dialogue", () => {
    expect(charSimilarity("mujhe office jaana hai", "mujhe office jaana hai")).toBe(1);
    expect(charSimilarity("mujhe office jaana hai", "aaj mausam accha hai")).toBeLessThan(0.6);
  });
});

describe("tokenSimilarity", () => {
  it("is 1 for the same words in a different order", () => {
    expect(tokenSimilarity("now leave to need we", "we need to leave now")).toBe(1);
  });

  it("is partial when only some words overlap", () => {
    const sim = tokenSimilarity("we need to leave now", "we need to leave soon");
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });
});

describe("textSimilarity", () => {
  it("scores an accidentally repeated sentence very high", () => {
    expect(textSimilarity("I will meet you at the station", "I will meet you at the station")).toBeGreaterThan(0.95);
  });

  it("scores a single repeated word very high", () => {
    expect(textSimilarity("okay", "okay")).toBeGreaterThan(0.95);
  });

  it("scores two different sentences low even if similar length", () => {
    expect(textSimilarity("please close the door behind you", "can you bring the car around front")).toBeLessThan(0.4);
  });

  it("scores near-duplicate Hindi-English mixed dialogue high", () => {
    expect(textSimilarity("kal hum market jaayenge", "kal hum market jaayenge")).toBeGreaterThan(0.95);
  });
});

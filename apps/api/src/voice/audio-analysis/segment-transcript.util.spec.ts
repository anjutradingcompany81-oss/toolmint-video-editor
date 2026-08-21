import { groupWordsIntoSegments } from "./segment-transcript.util";

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
});

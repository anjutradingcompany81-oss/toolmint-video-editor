import { buildDrawTextFilters, escapeFilterPath, fontPathForText, type TextClipSegment } from "./text-clip.util";

function seg(over: Partial<TextClipSegment> = {}): TextClipSegment {
  return {
    textFilePath: "/tmp/work/text0.txt",
    fontFilePath: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    fontSize: 48,
    colorHex: "#F8FAFC",
    opacity: 1,
    x: 100,
    y: 200,
    startMs: 1000,
    durationMs: 3000,
    ...over,
  };
}

describe("fontPathForText", () => {
  it("uses the Latin font for Latin text", () => {
    expect(fontPathForText("The Lion and the Ant")).toContain("DejaVuSans");
  });

  it("uses the Devanagari font for Hindi, which DejaVu cannot draw at all", () => {
    // Drawn with DejaVu this comes out as empty boxes — which reads as a
    // broken feature rather than a missing font.
    expect(fontPathForText("बहुत बहुत धन्यवाद")).toContain("Devanagari");
  });

  it("uses the Devanagari font when a title mixes scripts", () => {
    expect(fontPathForText("Scene 1 - धन्यवाद")).toContain("Devanagari");
  });
});

describe("escapeFilterPath", () => {
  it("escapes a Windows drive colon, which would otherwise end the option", () => {
    expect(escapeFilterPath("C:/work/text.txt")).toBe("C\\:/work/text.txt");
  });

  it("normalises backslashes, which are escape characters in a filtergraph", () => {
    expect(escapeFilterPath("C:\\work\\text.txt")).toBe("C\\:/work/text.txt");
  });

  it("escapes a quote so it cannot close the option early", () => {
    expect(escapeFilterPath("/tmp/it's/text.txt")).toBe("/tmp/it\\'s/text.txt");
  });
});

describe("buildDrawTextFilters", () => {
  it("draws nothing when there are no text clips", () => {
    expect(buildDrawTextFilters([])).toBe("");
  });

  it("passes the text by file rather than inline", () => {
    // Inline text would have to escape colons, quotes, backslashes,
    // percent signs and commas — and a title is exactly where someone
    // types an apostrophe.
    const filter = buildDrawTextFilters([seg()]);
    expect(filter).toContain("textfile='/tmp/work/text0.txt'");
    expect(filter).not.toMatch(/(^|:)text=/);
  });

  it("gates each clip to its own window, not the whole video", () => {
    expect(buildDrawTextFilters([seg({ startMs: 2000, durationMs: 1500 })])).toContain("enable='between(t,2.000,3.500)'");
  });

  it("converts #RRGGBB to drawtext's colour form, carrying opacity", () => {
    expect(buildDrawTextFilters([seg({ colorHex: "#FF8800", opacity: 0.5 })])).toContain("fontcolor=0xFF8800@0.500");
  });

  it("rounds position and size, which drawtext takes as integers", () => {
    const filter = buildDrawTextFilters([seg({ x: 10.6, y: 20.4, fontSize: 47.8 })]);
    expect(filter).toContain("x=11");
    expect(filter).toContain("y=20");
    expect(filter).toContain("fontsize=48");
  });

  it("chains several clips into one filter string", () => {
    const filter = buildDrawTextFilters([seg({ textFilePath: "/tmp/a.txt" }), seg({ textFilePath: "/tmp/b.txt" })]);
    expect(filter.match(/drawtext=/g)).toHaveLength(2);
    expect(filter).toContain("/tmp/a.txt");
    expect(filter).toContain("/tmp/b.txt");
  });

  it("skips a zero-length or zero-size clip instead of emitting an invalid filter", () => {
    expect(buildDrawTextFilters([seg({ durationMs: 0 })])).toBe("");
    expect(buildDrawTextFilters([seg({ fontSize: 0 })])).toBe("");
  });
});

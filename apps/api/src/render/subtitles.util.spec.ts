import { escapeSubtitlePath, toForceStyle, toSrt, toVtt } from "./subtitles.util";
import type { SubtitleCue, SubtitleStyle } from "../projects/composition.schema";

function cue(id: string, startMs: number, endMs: number, text: string): SubtitleCue {
  return { id, startMs, endMs, text };
}

const STYLE: SubtitleStyle = { fontSizePx: 24, colorHex: "#FFFFFF", outlineHex: "#000000", position: "BOTTOM", burnIn: true };

describe("toSrt", () => {
  it("writes sequential indices and HH:MM:SS,mmm timestamps", () => {
    const srt = toSrt([cue("a", 0, 1500, "Hello"), cue("b", 2000, 3250, "World")]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:02,000 --> 00:00:03,250\nWorld\n");
  });

  it("formats past an hour correctly", () => {
    const srt = toSrt([cue("a", 3_661_010, 3_662_000, "Late")]);
    expect(srt).toContain("01:01:01,010 --> 01:01:02,000");
  });

  it("sorts cues by start time regardless of the order they were edited in", () => {
    const srt = toSrt([cue("b", 5000, 6000, "Second"), cue("a", 1000, 2000, "First")]);
    expect(srt.indexOf("First")).toBeLessThan(srt.indexOf("Second"));
    expect(srt.startsWith("1\n00:00:01,000")).toBe(true);
  });

  it("trims an overlapping cue back to the next cue's start", () => {
    // Players flicker or drop lines when cues overlap, and ffmpeg's
    // subtitles filter silently discards some of them.
    const srt = toSrt([cue("a", 0, 5000, "Long"), cue("b", 2000, 3000, "Next")]);
    expect(srt).toContain("00:00:00,000 --> 00:00:02,000");
  });

  it("drops blank cues rather than emitting an empty subtitle block", () => {
    const srt = toSrt([cue("a", 0, 1000, "   "), cue("b", 2000, 3000, "Real")]);
    expect(srt).toContain("Real");
    expect(srt.startsWith("1\n00:00:02,000")).toBe(true);
  });

  it("returns an empty string when there is nothing to write", () => {
    expect(toSrt([])).toBe("");
  });
});

describe("toVtt", () => {
  it("emits the mandatory WEBVTT header and dot-separated milliseconds", () => {
    const vtt = toVtt([cue("a", 0, 1500, "Hello")]);
    expect(vtt).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n");
  });

  it("still emits the header when there are no cues", () => {
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});

describe("toForceStyle", () => {
  it("converts #RRGGBB to ASS's byte-reversed &HBBGGRR", () => {
    const style = toForceStyle({ ...STYLE, colorHex: "#FF0000" });
    expect(style).toContain("PrimaryColour=&H0000FF"); // red -> BBGGRR
  });

  it("maps position to the matching ASS alignment", () => {
    expect(toForceStyle({ ...STYLE, position: "BOTTOM" })).toContain("Alignment=2");
    expect(toForceStyle({ ...STYLE, position: "TOP" })).toContain("Alignment=8");
  });

  it("carries the font size through", () => {
    expect(toForceStyle({ ...STYLE, fontSizePx: 48 })).toContain("FontSize=48");
  });
});

describe("escapeSubtitlePath", () => {
  it("escapes the colon in a Windows drive letter, which would otherwise split the filter option", () => {
    expect(escapeSubtitlePath("C:\\tmp\\subs.srt")).toBe("C\\:/tmp/subs.srt");
  });

  it("leaves a plain POSIX path alone", () => {
    expect(escapeSubtitlePath("/tmp/subs.srt")).toBe("/tmp/subs.srt");
  });
});

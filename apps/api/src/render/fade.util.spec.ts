import { buildAudioFadeFilters, buildVideoFadeFilters, resolveFades } from "./fade.util";

describe("resolveFades", () => {
  it("passes through a pair that comfortably fits", () => {
    expect(resolveFades({ fadeInMs: 500, fadeOutMs: 800, durationMs: 5000 })).toEqual({ inMs: 500, outMs: 800 });
  });

  it("gives the fade-out only what the fade-in left, so they cannot overlap", () => {
    // Overlapping fades make a clip that never reaches full brightness —
    // which looks like a broken render, not an effect.
    expect(resolveFades({ fadeInMs: 3000, fadeOutMs: 3000, durationMs: 4000 })).toEqual({ inMs: 3000, outMs: 1000 });
  });

  it("clamps a fade longer than the clip to the clip", () => {
    expect(resolveFades({ fadeInMs: 9000, fadeOutMs: 0, durationMs: 2000 })).toEqual({ inMs: 2000, outMs: 0 });
  });

  it("treats a sub-millisecond fade as none, rather than emitting d=0.000", () => {
    expect(resolveFades({ fadeInMs: 0, fadeOutMs: 0, durationMs: 5000 })).toEqual({ inMs: 0, outMs: 0 });
  });

  it("survives a zero-length clip without producing negative times", () => {
    expect(resolveFades({ fadeInMs: 500, fadeOutMs: 500, durationMs: 0 })).toEqual({ inMs: 0, outMs: 0 });
  });
});

describe("buildVideoFadeFilters", () => {
  it("adds no filter at all when no fade is set", () => {
    expect(buildVideoFadeFilters({ fadeInMs: 0, fadeOutMs: 0, durationMs: 5000 })).toBe("");
  });

  it("starts the fade-in at zero, i.e. in the clip's own time", () => {
    // Not the timeline's time: the clip is shifted to its position later
    // in the chain, so a fade timed against the timeline would fire at the
    // wrong moment or never at all.
    expect(buildVideoFadeFilters({ fadeInMs: 750, fadeOutMs: 0, durationMs: 5000 })).toBe("fade=t=in:st=0.000:d=0.750");
  });

  it("starts the fade-out so it finishes exactly at the clip's end", () => {
    expect(buildVideoFadeFilters({ fadeInMs: 0, fadeOutMs: 1000, durationMs: 5000 })).toBe("fade=t=out:st=4.000:d=1.000");
  });

  it("emits both fades in order", () => {
    expect(buildVideoFadeFilters({ fadeInMs: 500, fadeOutMs: 500, durationMs: 4000 })).toBe(
      "fade=t=in:st=0.000:d=0.500,fade=t=out:st=3.500:d=0.500",
    );
  });

  it("fades transparency for an overlay, so it reveals the picture underneath instead of punching a black hole", () => {
    const filter = buildVideoFadeFilters({ fadeInMs: 500, fadeOutMs: 500, durationMs: 4000 }, true);
    expect(filter).toContain("fade=t=in:st=0.000:d=0.500:alpha=1");
    expect(filter).toContain("fade=t=out:st=3.500:d=0.500:alpha=1");
  });
});

describe("buildAudioFadeFilters", () => {
  it("adds nothing when no fade is set", () => {
    expect(buildAudioFadeFilters({ fadeInMs: 0, fadeOutMs: 0, durationMs: 5000 })).toBe("");
  });

  it("mirrors the video timings so sound and picture fade together", () => {
    expect(buildAudioFadeFilters({ fadeInMs: 500, fadeOutMs: 1000, durationMs: 5000 })).toBe(
      "afade=t=in:st=0.000:d=0.500,afade=t=out:st=4.000:d=1.000",
    );
  });
});

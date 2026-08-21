import { buildMergeArgs, computeDimensions, playableDurationMs, type ClipSegment } from "./merge-ffmpeg.util";

function buildClip(overrides: Partial<ClipSegment> = {}): ClipSegment {
  return {
    localPath: "/tmp/clip.mp4",
    trimInMs: 0,
    trimOutMs: 0,
    sourceDurationMs: 10_000,
    hasAudio: true,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

describe("computeDimensions", () => {
  it("scales a landscape clip to the requested resolution's short edge", () => {
    expect(computeDimensions("R720P", 1920, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it("scales a portrait clip so height, not width, matches the short edge", () => {
    expect(computeDimensions("R720P", 1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it("passes through the source dimensions (evenized) for ORIGINAL", () => {
    expect(computeDimensions("ORIGINAL", 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("rounds odd source dimensions to the nearest even number for ORIGINAL", () => {
    expect(computeDimensions("ORIGINAL", 1921, 1081)).toEqual({ width: 1922, height: 1082 });
  });

  it("falls back to a 16:9 assumption when dimensions are missing", () => {
    expect(computeDimensions("R1080P", 0, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("playableDurationMs", () => {
  it("subtracts both trim offsets from the source duration", () => {
    expect(playableDurationMs({ sourceDurationMs: 10_000, trimInMs: 1000, trimOutMs: 2000 })).toBe(7000);
  });

  it("clamps to the minimum clip duration instead of going to zero or negative", () => {
    expect(playableDurationMs({ sourceDurationMs: 1000, trimInMs: 900, trimOutMs: 900 })).toBe(200);
  });
});

describe("buildMergeArgs", () => {
  it("throws when given no clips", () => {
    expect(() => buildMergeArgs({ clips: [], width: 1280, height: 720, fps: 30, quality: "STANDARD", outputPath: "/tmp/out.mp4" })).toThrow();
  });

  it("skips the concat filter entirely for a single clip, mapping vout/aout directly", () => {
    const args = buildMergeArgs({ clips: [buildClip()], width: 1280, height: 720, fps: 30, quality: "STANDARD", outputPath: "/tmp/out.mp4" });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("[vout]");
    expect(filter).toContain("[aout]");
    expect(filter).not.toContain("concat=");
  });

  it("concatenates multiple clips with an interleaved video/audio concat filter", () => {
    const args = buildMergeArgs({
      clips: [buildClip(), buildClip()],
      width: 1280,
      height: 720,
      fps: 30,
      quality: "STANDARD",
      outputPath: "/tmp/out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("concat=n=2:v=1:a=1[vout][aout]");
    expect(filter).toContain("[v0][a0][v1][a1]");
  });

  it("feeds every clip's localPath in as an -i input, in order", () => {
    const args = buildMergeArgs({
      clips: [buildClip({ localPath: "/tmp/a.mp4" }), buildClip({ localPath: "/tmp/b.mp4" })],
      width: 1280,
      height: 720,
      fps: 30,
      quality: "STANDARD",
      outputPath: "/tmp/out.mp4",
    });

    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/a.mp4", "-i", "/tmp/b.mp4"]));
    expect(args.indexOf("/tmp/a.mp4")).toBeLessThan(args.indexOf("/tmp/b.mp4"));
  });

  it("adds a synthetic silent-audio input for a clip with no audio track", () => {
    const args = buildMergeArgs({
      clips: [buildClip({ hasAudio: false })],
      width: 1280,
      height: 720,
      fps: 30,
      quality: "STANDARD",
      outputPath: "/tmp/out.mp4",
    });

    expect(args).toEqual(expect.arrayContaining(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]));
  });

  it("does not add a silent-audio input when every clip already has audio", () => {
    const args = buildMergeArgs({ clips: [buildClip()], width: 1280, height: 720, fps: 30, quality: "STANDARD", outputPath: "/tmp/out.mp4" });

    expect(args).not.toEqual(expect.arrayContaining(["anullsrc=channel_layout=stereo:sample_rate=48000"]));
  });

  it("mutes a clip by zeroing its filter-graph volume instead of dropping the audio stream", () => {
    const args = buildMergeArgs({
      clips: [buildClip({ muted: true, volume: 1 })],
      width: 1280,
      height: 720,
      fps: 30,
      quality: "STANDARD",
      outputPath: "/tmp/out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("volume=0.000");
  });

  it("maps quality presets to the expected CRF and audio bitrate", () => {
    const standard = buildMergeArgs({ clips: [buildClip()], width: 1280, height: 720, fps: 30, quality: "STANDARD", outputPath: "/tmp/out.mp4" });
    const maximum = buildMergeArgs({ clips: [buildClip()], width: 1280, height: 720, fps: 30, quality: "MAXIMUM", outputPath: "/tmp/out.mp4" });

    expect(standard).toEqual(expect.arrayContaining(["-crf", "23", "-b:a", "128k"]));
    expect(maximum).toEqual(expect.arrayContaining(["-crf", "16", "-b:a", "256k"]));
  });

  it("always writes -y and the given output path last", () => {
    const args = buildMergeArgs({ clips: [buildClip()], width: 1280, height: 720, fps: 30, quality: "STANDARD", outputPath: "/tmp/out.mp4" });

    expect(args[args.length - 2]).toBe("-y");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});

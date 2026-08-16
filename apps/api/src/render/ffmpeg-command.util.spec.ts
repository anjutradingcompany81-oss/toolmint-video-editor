import { buildFfmpegArgs, checkContiguous, computeDimensions } from "./ffmpeg-command.util";

describe("computeDimensions", () => {
  it("computes 16:9 landscape dimensions at each resolution tier", () => {
    expect(computeDimensions("RATIO_16_9", "R720P")).toEqual({ width: 1280, height: 720 });
    expect(computeDimensions("RATIO_16_9", "R1080P")).toEqual({ width: 1920, height: 1080 });
  });

  it("computes 9:16 vertical dimensions with the short edge as width", () => {
    expect(computeDimensions("RATIO_9_16", "R720P")).toEqual({ width: 720, height: 1280 });
  });

  it("computes square dimensions", () => {
    expect(computeDimensions("RATIO_1_1", "R720P")).toEqual({ width: 720, height: 720 });
  });

  it("uses the project's custom dimensions verbatim (rounded to even) when aspectRatio is CUSTOM", () => {
    expect(computeDimensions("CUSTOM", "R1080P", 999, 501)).toEqual({ width: 1000, height: 502 });
  });

  it("falls back to 16:9 for an unrecognized aspect ratio key", () => {
    expect(computeDimensions("SOMETHING_NEW", "R720P")).toEqual({ width: 1280, height: 720 });
  });
});

describe("checkContiguous", () => {
  it("accepts back-to-back clips starting at zero", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 2000 },
      { startMs: 2000, durationMs: 3000 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts a single clip starting at zero", () => {
    expect(checkContiguous([{ startMs: 0, durationMs: 5000 }]).ok).toBe(true);
  });

  it("rejects an empty track", () => {
    const result = checkContiguous([]);
    expect(result.ok).toBe(false);
  });

  it("rejects a track that doesn't start at zero", () => {
    const result = checkContiguous([{ startMs: 1000, durationMs: 2000 }]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("start at 0:00") });
  });

  it("rejects a gap between clips", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 2000 },
      { startMs: 5000, durationMs: 2000 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("gap") });
  });

  it("rejects overlapping clips", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 3000 },
      { startMs: 2000, durationMs: 2000 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("overlap") });
  });

  it("is order-independent — sorts before checking", () => {
    const result = checkContiguous([
      { startMs: 2000, durationMs: 3000 },
      { startMs: 0, durationMs: 2000 },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("buildFfmpegArgs", () => {
  it("throws when there are no video segments", () => {
    expect(() => buildFfmpegArgs({ video: [], audio: [], width: 1280, height: 720, fps: 30, outputPath: "out.mp4" })).toThrow();
  });

  it("builds a single-clip, video-only command", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000 }],
      audio: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    expect(args).toEqual(
      expect.arrayContaining(["-i", "clip.mp4", "-map", "[vout]", "-c:v", "libx264", "-y", "out.mp4"]),
    );
    expect(args).not.toContain("[aout]");
    const filterIndex = args.indexOf("-filter_complex");
    expect(args[filterIndex + 1]).toContain("trim=start=0.000:duration=5.000");
    expect(args[filterIndex + 1]).toContain("concat=n=1:v=1:a=0[vout]");
  });

  it("loops still images at the input level instead of trimming them", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "photo.jpg", kind: "image", trimInMs: 0, durationMs: 3000 }],
      audio: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    expect(args.slice(0, 6)).toEqual(["-loop", "1", "-t", "3.000", "-i", "photo.jpg"]);
  });

  it("concatenates multiple clips in order and mixes in a matching audio chain", () => {
    const args = buildFfmpegArgs({
      video: [
        { localPath: "a.mp4", kind: "video", trimInMs: 0, durationMs: 2000 },
        { localPath: "b.mp4", kind: "video", trimInMs: 1000, durationMs: 3000 },
      ],
      audio: [{ localPath: "music.mp3", trimInMs: 0, durationMs: 5000 }],
      width: 1920,
      height: 1080,
      fps: 24,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("concat=n=2:v=1:a=0[vout]");
    expect(filter).toContain("concat=n=1:v=0:a=1[aout]");
    expect(filter).toContain("[1:v]trim=start=1.000:duration=3.000");
    expect(args).toEqual(expect.arrayContaining(["-map", "[aout]", "-c:a", "aac", "-shortest"]));
  });
});

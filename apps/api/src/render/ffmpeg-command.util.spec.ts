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

  it("accepts a bounded overlap as an implicit transition", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 3000 },
      { startMs: 2000, durationMs: 2000 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an overlap long enough to consume the first clip entirely", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 2000 },
      { startMs: 0, durationMs: 3000 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("longer than one of the clips") });
  });

  it("rejects an overlap long enough to consume the second clip entirely", () => {
    const result = checkContiguous([
      { startMs: 0, durationMs: 5000 },
      { startMs: 4000, durationMs: 1000 },
    ]);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("longer than one of the clips") });
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
    expect(() => buildFfmpegArgs({ video: [], audio: [], text: [], width: 1280, height: 720, fps: 30, outputPath: "out.mp4" })).toThrow();
  });

  it("builds a single-clip, video-only command", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
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
    expect(args[filterIndex + 1]).toContain("[vout]");
    expect(args[filterIndex + 1]).not.toContain("concat");
  });

  it("doubles the trim length and halves setpts for a 200% speed video clip", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 1000, durationMs: 2000, speedPercent: 200, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    // durationMs (2000ms) is the *timeline* footprint; at 2x speed that
    // plays through 4000ms of source, which the trim step must consume —
    // then setpts halves the timestamps back down to the 2000ms footprint.
    expect(filter).toContain("trim=start=1.000:duration=4.000");
    expect(filter).toContain("setpts=(PTS-STARTPTS)/2.0000");
  });

  it("stretches the trim length and doubles setpts for a 50% speed (slow-motion) video clip", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 4000, speedPercent: 50, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("trim=start=0.000:duration=2.000");
    expect(filter).toContain("setpts=(PTS-STARTPTS)/0.5000");
  });

  it("doesn't touch setpts at all for a normal-speed (100%) clip", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 2000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("setpts=PTS-STARTPTS,");
    expect(filter).not.toContain("setpts=(PTS-STARTPTS)/");
  });

  it("never applies speed to a still image, even if speedPercent were somehow non-100", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "photo.jpg", kind: "image", trimInMs: 0, durationMs: 3000, speedPercent: 200, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("trim=start=0.000:duration=3.000");
    expect(filter).toContain("setpts=PTS-STARTPTS,");
  });

  it("adds a single atempo stage within ffmpeg's native 0.5-2.0 range", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 1000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [{ localPath: "music.mp3", trimInMs: 0, durationMs: 2000, speedPercent: 150, transitionInMs: 0 }],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    // durationMs (2000ms timeline) * 1.5 speed = 3000ms of source consumed.
    expect(filter).toContain("atrim=start=0.000:duration=3.000");
    expect(filter).toContain("atempo=1.5000");
  });

  it("chains two atempo stages for a 400% audio speed, since a single stage tops out at 2.0", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 1000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [{ localPath: "music.mp3", trimInMs: 0, durationMs: 4000, speedPercent: 400, transitionInMs: 0 }],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("atempo=2.0000,atempo=2.0000");
  });

  it("chains two atempo stages for a 25% audio speed, since a single stage bottoms out at 0.5", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 1000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [{ localPath: "music.mp3", trimInMs: 0, durationMs: 4000, speedPercent: 25, transitionInMs: 0 }],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("atempo=0.5000,atempo=0.5000");
  });

  it("loops still images at the input level instead of trimming them", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "photo.jpg", kind: "image", trimInMs: 0, durationMs: 3000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    expect(args.slice(0, 6)).toEqual(["-loop", "1", "-t", "3.000", "-i", "photo.jpg"]);
  });

  it("concatenates multiple hard-cut clips in order and mixes in a single audio track (no pointless concat for one segment)", () => {
    const args = buildFfmpegArgs({
      video: [
        { localPath: "a.mp4", kind: "video", trimInMs: 0, durationMs: 2000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" },
        { localPath: "b.mp4", kind: "video", trimInMs: 1000, durationMs: 3000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" },
      ],
      audio: [{ localPath: "music.mp3", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0 }],
      text: [],
      width: 1920,
      height: 1080,
      fps: 24,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("concat=n=2:v=1:a=0[vout]");
    expect(filter).toContain("[2:a]atrim=start=0.000:duration=5.000,asetpts=PTS-STARTPTS[aout]");
    expect(filter).not.toContain("concat=n=1:v=0:a=1");
    expect(filter).toContain("[1:v]trim=start=1.000:duration=3.000");
    expect(args).toEqual(expect.arrayContaining(["-map", "[aout]", "-c:a", "aac", "-shortest"]));
  });

  it("concatenates three hard-cut audio segments (no transitions)", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [
        { localPath: "a.mp3", trimInMs: 0, durationMs: 2000, speedPercent: 100, transitionInMs: 0 },
        { localPath: "b.mp3", trimInMs: 0, durationMs: 2000, speedPercent: 100, transitionInMs: 0 },
      ],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("concat=n=2:v=0:a=1[aout]");
  });

  it("chains an xfade instead of concat when a video segment declares a transition", () => {
    const args = buildFfmpegArgs({
      video: [
        { localPath: "a.mp4", kind: "video", trimInMs: 0, durationMs: 3000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" },
        { localPath: "b.mp4", kind: "video", trimInMs: 0, durationMs: 4000, speedPercent: 100, transitionInMs: 1000, transitionType: "wipeleft" },
      ],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).not.toContain("concat=n=2:v=1:a=0");
    // offset = duration of clip A (3s) minus the transition (1s) = 2s.
    expect(filter).toContain("[v0][v1]xfade=transition=wipeleft:duration=1.000:offset=2.000[vout]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vout]"]));
  });

  it("chains xfade offsets cumulatively across three clips with two transitions", () => {
    const args = buildFfmpegArgs({
      video: [
        { localPath: "a.mp4", kind: "video", trimInMs: 0, durationMs: 3000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" },
        { localPath: "b.mp4", kind: "video", trimInMs: 0, durationMs: 4000, speedPercent: 100, transitionInMs: 1000, transitionType: "fade" },
        { localPath: "c.mp4", kind: "video", trimInMs: 0, durationMs: 2000, speedPercent: 100, transitionInMs: 500, transitionType: "fade" },
      ],
      audio: [],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    // Merged-so-far duration after the first xfade: 3000 + 4000 - 1000 = 6000ms.
    // Second offset = 6000 - 500 = 5500ms.
    expect(filter).toContain("[v0][v1]xfade=transition=fade:duration=1.000:offset=2.000[vxf1]");
    expect(filter).toContain("[vxf1][v2]xfade=transition=fade:duration=0.500:offset=5.500[vout]");
  });

  it("chains an acrossfade instead of concat when an audio segment declares a transition", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [
        { localPath: "a.mp3", trimInMs: 0, durationMs: 3000, speedPercent: 100, transitionInMs: 0 },
        { localPath: "b.mp3", trimInMs: 0, durationMs: 3000, speedPercent: 100, transitionInMs: 800 },
      ],
      text: [],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).not.toContain("concat=n=2:v=0:a=1");
    expect(filter).toContain("[a0][a1]acrossfade=d=0.800[aout]");
  });

  it("chains a drawtext filter for a text overlay and maps its output instead of [vout]", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [{ textFilePath: "text0.txt", startMs: 1000, durationMs: 2000, fontSize: 48, color: "#ffcc00", x: 10, y: -20, opacity: 0.5 }],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("[vout]drawtext=");
    expect(filter).toContain("textfile='text0.txt'");
    expect(filter).toContain("fontsize=48");
    expect(filter).toContain("fontcolor=0xffcc00@0.5");
    expect(filter).toContain("x=(w-text_w)/2+10");
    expect(filter).toContain("y=(h-text_h)/2+-20");
    expect(filter).toContain("enable='between(t,1.000,3.000)'[vtxt0]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vtxt0]"]));
    expect(args).not.toContain("[vout]");
  });

  it("chains multiple text overlays in order, each feeding the next", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [
        { textFilePath: "text0.txt", startMs: 0, durationMs: 2000, fontSize: 40, color: "#ffffff", x: 0, y: 0, opacity: 1 },
        { textFilePath: "text1.txt", startMs: 2000, durationMs: 2000, fontSize: 40, color: "#ffffff", x: 0, y: 0, opacity: 1 },
      ],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("[vout]drawtext=");
    expect(filter).toContain("[vtxt0]drawtext=");
    expect(filter).toContain("[vtxt1]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[vtxt1]"]));
  });

  it("escapes a Windows-style font/text path so the colon and backslashes don't break filter parsing", () => {
    const args = buildFfmpegArgs({
      video: [{ localPath: "clip.mp4", kind: "video", trimInMs: 0, durationMs: 5000, speedPercent: 100, transitionInMs: 0, transitionType: "fade" }],
      audio: [],
      text: [{ textFilePath: "C:\\Users\\me\\AppData\\text0.txt", startMs: 0, durationMs: 1000, fontSize: 40, color: "#ffffff", x: 0, y: 0, opacity: 1 }],
      width: 1280,
      height: 720,
      fps: 30,
      outputPath: "out.mp4",
    });

    const filterIndex = args.indexOf("-filter_complex");
    const filter = args[filterIndex + 1];
    expect(filter).toContain("textfile='C\\:/Users/me/AppData/text0.txt'");
  });
});

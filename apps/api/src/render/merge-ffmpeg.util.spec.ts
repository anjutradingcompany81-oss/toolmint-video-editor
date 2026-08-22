import {
  buildClipAudioFilterChain,
  buildMultitrackMergeArgs,
  computeDimensions,
  playableDurationMs,
  type AudioClipSegment,
  type VisualClipSegment,
} from "./merge-ffmpeg.util";

function buildVisual(overrides: Partial<VisualClipSegment> = {}): VisualClipSegment {
  return {
    localPath: "/tmp/clip.mp4",
    kind: "video",
    trackOrder: 0,
    startMs: 0,
    durationMs: 5000,
    trimInMs: 0,
    sourceWidth: 1280,
    sourceHeight: 720,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    ...overrides,
  };
}

function buildAudio(overrides: Partial<AudioClipSegment> = {}): AudioClipSegment {
  return {
    localPath: "/tmp/audio.mp4",
    startMs: 0,
    durationMs: 5000,
    trimInMs: 0,
    sourceDurationMs: 5000,
    hasAudio: true,
    volume: 1,
    audioPatches: [],
    ...overrides,
  };
}

const BASE_PLAN = { width: 1280, height: 720, fps: 30, totalDurationMs: 5000, quality: "STANDARD" as const, outputPath: "/tmp/out.mp4" };

describe("computeDimensions", () => {
  it("scales a landscape base clip to the requested resolution's short edge", () => {
    expect(computeDimensions("R720P", 1920, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it("scales a portrait base clip so height, not width, matches the short edge", () => {
    expect(computeDimensions("R720P", 1080, 1920)).toEqual({ width: 720, height: 1280 });
  });

  it("passes through the source dimensions (evenized) for ORIGINAL", () => {
    expect(computeDimensions("ORIGINAL", 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to a 16:9 assumption when dimensions are missing", () => {
    expect(computeDimensions("R1080P", 0, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("playableDurationMs", () => {
  it("subtracts both trims from the source duration", () => {
    expect(playableDurationMs({ sourceDurationMs: 10_000, trimInMs: 1000, trimOutMs: 2000 })).toBe(7000);
  });

  it("clamps to the minimum instead of going to zero or negative", () => {
    expect(playableDurationMs({ sourceDurationMs: 1000, trimInMs: 900, trimOutMs: 900 })).toBe(200);
  });
});

describe("buildMultitrackMergeArgs", () => {
  it("throws when given no visual clips", () => {
    expect(() => buildMultitrackMergeArgs({ ...BASE_PLAN, visualClips: [], audioClips: [] })).toThrow();
  });

  it("builds a black+silent base canvas sized and timed to the whole project", () => {
    const args = buildMultitrackMergeArgs({ ...BASE_PLAN, visualClips: [buildVisual()], audioClips: [] });
    expect(args).toEqual(expect.arrayContaining(["color=size=1280x720:rate=30:duration=5.000:color=black"]));
    expect(args).toEqual(expect.arrayContaining(["anullsrc=channel_layout=stereo:sample_rate=48000"]));
  });

  it("feeds every visual clip's localPath in as an -i input", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual({ localPath: "/tmp/a.mp4" }), buildVisual({ localPath: "/tmp/b.mp4", trackOrder: 1 })],
      audioClips: [],
    });
    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/a.mp4"]));
    expect(args).toEqual(expect.arrayContaining(["-i", "/tmp/b.mp4"]));
  });

  it("composites clips in ascending track order regardless of input array order", () => {
    const bottom = buildVisual({ localPath: "/tmp/bottom.mp4", trackOrder: 0 });
    const top = buildVisual({ localPath: "/tmp/top.mp4", trackOrder: 5 });
    // Handed in reverse order on purpose — the filter graph must still overlay bottom (v0) first.
    const args = buildMultitrackMergeArgs({ ...BASE_PLAN, visualClips: [top, bottom], audioClips: [] });
    const filter = args[args.indexOf("-filter_complex") + 1];

    const v0Pos = filter.indexOf("[base][v0]overlay");
    const v1Pos = filter.indexOf("[comp0][v1]overlay");
    expect(v0Pos).toBeGreaterThan(-1);
    expect(v1Pos).toBeGreaterThan(v0Pos);
  });

  it("gates each overlay to its own start/end window", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual({ startMs: 1000, durationMs: 2000 })],
      audioClips: [],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("enable='between(t,1.000,3.000)'");
  });

  it("scales a video-kind clip to fill the canvas by default", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual({ kind: "video", sourceWidth: 640, sourceHeight: 360, transform: { x: 0, y: 0, scale: 1, opacity: 1 } })],
      audioClips: [],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    // Canvas is 1280x720 — a video-kind clip at scale=1 targets the canvas size, not its own source size.
    expect(filter).toContain("scale=1280:720:force_original_aspect_ratio=decrease");
  });

  it("scales an overlay-kind clip to its own natural size by default, not the canvas", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [
        buildVisual({ kind: "video" }),
        buildVisual({ kind: "overlay", trackOrder: 1, sourceWidth: 300, sourceHeight: 150, transform: { x: 20, y: 20, scale: 1, opacity: 1 } }),
      ],
      audioClips: [],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    // A logo-sized overlay should never default to covering the whole 1280x720 canvas.
    expect(filter).toContain("scale=300:150:force_original_aspect_ratio=decrease");
    expect(filter).not.toContain("scale=1280:720:force_original_aspect_ratio=decrease,format=yuva420p,colorchannelmixer=aa=1.000[v1]");
    expect(filter).toContain("overlay=x=20:y=20");
  });

  it("applies opacity via colorchannelmixer", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual({ transform: { x: 0, y: 0, scale: 1, opacity: 0.5 } })],
      audioClips: [],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("colorchannelmixer=aa=0.500");
  });

  it("loops a still image across its clip's whole span instead of a single frame", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [
        buildVisual({ kind: "video" }),
        buildVisual({ kind: "overlay", trackOrder: 1, isStillImage: true, startMs: 0, durationMs: 12_000, localPath: "/tmp/logo.png" }),
      ],
      audioClips: [],
    });
    const logoInput = args.indexOf("/tmp/logo.png");
    expect(logoInput).toBeGreaterThan(-1);
    // Input options only apply to the -i that FOLLOWS them; ffmpeg silently
    // ignores them if they land after their input.
    expect(args.slice(logoInput - 5, logoInput)).toEqual(["-loop", "1", "-t", "12.000", "-i"]);
  });

  it("does not loop a time-based source", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual({ kind: "video", localPath: "/tmp/clip.mp4" })],
      audioClips: [],
    });
    const idx = args.indexOf("/tmp/clip.mp4");
    expect(args[idx - 1]).toBe("-i");
    expect(args.slice(0, idx)).not.toContain("-loop");
  });

  it("mixes the base silence alone when there are no audio clips", () => {
    const args = buildMultitrackMergeArgs({ ...BASE_PLAN, visualClips: [buildVisual()], audioClips: [] });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("[1:a]anull[aout]");
    expect(filter).not.toContain("amix");
  });

  it("mixes multiple audio-bearing clips with amix, each delayed to its own start time", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual()],
      audioClips: [buildAudio({ startMs: 0 }), buildAudio({ startMs: 2000, localPath: "/tmp/voice.mp3" })],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("adelay=0|0");
    expect(filter).toContain("adelay=2000|2000");
    expect(filter).toContain("amix=inputs=3"); // base silence + 2 real audio clips
  });

  it("does not add a filter stage for a clip with no source audio", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual()],
      audioClips: [buildAudio({ hasAudio: false })],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    // Only the base silence contributes — no amix needed for a single source.
    expect(filter).toContain("[1:a]anull[aout]");
    expect(filter).not.toContain("amix");
  });

  it("applies per-clip volume to audio segments", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual()],
      audioClips: [buildAudio({ volume: 0.25 })],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("volume=0.250");
  });

  it("maps quality presets to the expected CRF and audio bitrate", () => {
    const standard = buildMultitrackMergeArgs({ ...BASE_PLAN, quality: "STANDARD", visualClips: [buildVisual()], audioClips: [] });
    const maximum = buildMultitrackMergeArgs({ ...BASE_PLAN, quality: "MAXIMUM", visualClips: [buildVisual()], audioClips: [] });
    expect(standard).toEqual(expect.arrayContaining(["-crf", "23", "-b:a", "128k"]));
    expect(maximum).toEqual(expect.arrayContaining(["-crf", "16", "-b:a", "256k"]));
  });

  it("always writes -y and the given output path last", () => {
    const args = buildMultitrackMergeArgs({ ...BASE_PLAN, visualClips: [buildVisual()], audioClips: [] });
    expect(args[args.length - 2]).toBe("-y");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("splices a room-tone patch into a clip's audio without changing the clip's overall duration", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual()],
      audioClips: [
        buildAudio({
          durationMs: 5000,
          audioPatches: [{ startMs: 2000, endMs: 3000, roomToneSourceStartMs: 100, roomToneSourceEndMs: 400 }],
        }),
      ],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    // Loops the 300ms room-tone reference to cover the full 1000ms gap, then caps it back down.
    expect(filter).toContain("atrim=start=0.100:duration=0.300");
    expect(filter).toContain("aloop=loop=-1:size=2147483647");
    expect(filter).toContain("atrim=duration=1.000");
    // The clip's own [outputLabel] is still delayed/mixed exactly as an unpatched clip would be —
    // the patch is fully absorbed before that point, so adelay math never sees it.
    expect(filter).toContain("adelay=0|0");
  });

  it("falls back to soft synthesized ambience when a patch has no room-tone reference", () => {
    const args = buildMultitrackMergeArgs({
      ...BASE_PLAN,
      visualClips: [buildVisual()],
      audioClips: [buildAudio({ durationMs: 5000, audioPatches: [{ startMs: 1000, endMs: 1500 }] })],
    });
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("anoisesrc=color=pink:duration=0.500");
  });
});

describe("buildClipAudioFilterChain", () => {
  it("returns a single plain atrim segment when there are no patches", () => {
    const { filterLines, outputLabel } = buildClipAudioFilterChain({ trimInMs: 500, durationMs: 4000, audioPatches: [] }, 3, "x");
    expect(filterLines).toEqual(["[3:a]atrim=start=0.500:duration=4.000,asetpts=PTS-STARTPTS[xsrc]"]);
    expect(outputLabel).toBe("xsrc");
  });

  it("keeps real source audio on either side of a single patch and concatenates back to full duration", () => {
    const { filterLines, outputLabel } = buildClipAudioFilterChain(
      { trimInMs: 0, durationMs: 5000, audioPatches: [{ startMs: 2000, endMs: 3000, roomToneSourceStartMs: 0, roomToneSourceEndMs: 500 }] },
      0,
      "a0_",
    );
    expect(filterLines.some((l) => l.includes("atrim=start=0.000:duration=2.000") && l.includes("[a0_seg0]"))).toBe(true); // pre-patch
    expect(filterLines.some((l) => l.includes("[a0_seg2]") && l.includes("atrim=start=3.000:duration=2.000"))).toBe(true); // post-patch
    expect(filterLines.some((l) => l.includes("concat=n=3:v=0:a=1[a0_src]"))).toBe(true);
    expect(outputLabel).toBe("a0_src");
  });

  it("applies a short fade at every patch boundary so the join has no click", () => {
    const { filterLines } = buildClipAudioFilterChain(
      { trimInMs: 0, durationMs: 5000, audioPatches: [{ startMs: 2000, endMs: 3000, roomToneSourceStartMs: 0, roomToneSourceEndMs: 500 }] },
      0,
      "a0_",
    );
    const prePatch = filterLines.find((l) => l.includes("[a0_seg0]"))!;
    const patch = filterLines.find((l) => l.includes("[a0_seg1]"))!;
    const postPatch = filterLines.find((l) => l.includes("[a0_seg2]"))!;
    expect(prePatch).toContain("afade=t=out");
    expect(patch).toContain("afade=t=in");
    expect(patch).toContain("afade=t=out");
    expect(postPatch).toContain("afade=t=in");
  });

  it("handles a patch that covers the clip's entire duration (no keep segments)", () => {
    const { filterLines, outputLabel } = buildClipAudioFilterChain(
      { trimInMs: 0, durationMs: 1000, audioPatches: [{ startMs: 0, endMs: 1000 }] },
      0,
      "a0_",
    );
    expect(filterLines.some((l) => l.includes("anull[a0_src]"))).toBe(true);
    expect(outputLabel).toBe("a0_src");
  });

  it("handles two separate patches on the same clip", () => {
    const { filterLines } = buildClipAudioFilterChain(
      {
        trimInMs: 0,
        durationMs: 6000,
        audioPatches: [
          { startMs: 1000, endMs: 1500, roomToneSourceStartMs: 0, roomToneSourceEndMs: 200 },
          { startMs: 4000, endMs: 4400, roomToneSourceStartMs: 0, roomToneSourceEndMs: 200 },
        ],
      },
      0,
      "a0_",
    );
    // keep(0-1000), patch, keep(1500-4000), patch, keep(4400-6000) = 5 segment-defining
    // lines, plus one concat line that references all five by label.
    expect(filterLines.filter((l) => /\[a0_seg\d]$/.test(l))).toHaveLength(5);
    expect(filterLines.some((l) => l.includes("concat=n=5:v=0:a=1"))).toBe(true);
  });
});

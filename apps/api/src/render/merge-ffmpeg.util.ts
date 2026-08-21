// Pure helpers for planning a merge render — no file I/O or process
// spawning, so the filter-graph logic can be unit tested without a real
// ffmpeg binary. ProCut's whole model is one ordered list of clips
// concatenated with hard cuts (no scenes, no transitions-as-objects, no
// text overlays) — this is deliberately much simpler than a multi-track
// renderer.

export const MIN_CLIP_DURATION_MS = 200;

const ASPECT_STANDARD_SHORT_EDGE = { R720P: 720, R1080P: 1080 } as const;

export type Resolution = "R720P" | "R1080P" | "ORIGINAL";
export type Quality = "STANDARD" | "HIGH" | "MAXIMUM";

const QUALITY_PRESETS: Record<Quality, { crf: number; audioBitrate: string }> = {
  STANDARD: { crf: 23, audioBitrate: "128k" },
  HIGH: { crf: 20, audioBitrate: "192k" },
  MAXIMUM: { crf: 16, audioBitrate: "256k" },
};

function evenize(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

// The merged canvas takes its shape from the *first* clip — every other
// clip gets letterboxed/pillarboxed to fit rather than stretched, so a
// portrait clip spliced after a landscape one doesn't distort either one.
export function computeDimensions(resolution: Resolution, firstClipWidth: number, firstClipHeight: number): { width: number; height: number } {
  const ratio = firstClipWidth > 0 && firstClipHeight > 0 ? firstClipWidth / firstClipHeight : 16 / 9;

  if (resolution === "ORIGINAL") {
    return { width: evenize(firstClipWidth || 1280), height: evenize(firstClipHeight || 720) };
  }

  const shortEdge = ASPECT_STANDARD_SHORT_EDGE[resolution];
  return ratio >= 1 ? { width: evenize(shortEdge * ratio), height: evenize(shortEdge) } : { width: evenize(shortEdge), height: evenize(shortEdge / ratio) };
}

export interface ClipSegment {
  localPath: string;
  trimInMs: number;
  trimOutMs: number;
  // The source file's own total length — needed to compute the playable
  // span (sourceDurationMs - trimInMs - trimOutMs) and to clamp trims that
  // would otherwise overrun the file.
  sourceDurationMs: number;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
}

export interface MergePlan {
  clips: ClipSegment[];
  width: number;
  height: number;
  fps: number;
  quality: Quality;
  outputPath: string;
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

// A clip's playable duration after trimming — clamped to never go
// negative or below the floor, which would otherwise produce a zero/
// negative -t argument ffmpeg rejects outright.
export function playableDurationMs(clip: Pick<ClipSegment, "sourceDurationMs" | "trimInMs" | "trimOutMs">): number {
  return Math.max(MIN_CLIP_DURATION_MS, clip.sourceDurationMs - clip.trimInMs - clip.trimOutMs);
}

export function buildMergeArgs(plan: MergePlan): string[] {
  if (plan.clips.length === 0) throw new Error("A merge plan needs at least one clip");

  const args: string[] = [];
  for (const clip of plan.clips) {
    args.push("-i", clip.localPath);
  }
  // One synthetic silent-audio input per clip that has no audio track of
  // its own — added *after* every real input so clip indices above stay
  // stable regardless of how many silent sources exist.
  const silentInputIndex = new Map<number, number>();
  plan.clips.forEach((clip, i) => {
    if (!clip.hasAudio) {
      silentInputIndex.set(i, plan.clips.length + silentInputIndex.size);
      args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
    }
  });

  const filterParts: string[] = [];
  const videoLabels = plan.clips.map((_, i) => (plan.clips.length === 1 ? "vout" : `v${i}`));
  const audioLabels = plan.clips.map((_, i) => (plan.clips.length === 1 ? "aout" : `a${i}`));

  plan.clips.forEach((clip, i) => {
    const durationS = sec(playableDurationMs(clip));
    filterParts.push(
      `[${i}:v]trim=start=${sec(clip.trimInMs)}:duration=${durationS},setpts=PTS-STARTPTS,` +
        `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,` +
        `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${plan.fps}[${videoLabels[i]}]`,
    );

    const volume = clip.muted ? 0 : clip.volume;
    if (clip.hasAudio) {
      filterParts.push(
        `[${i}:a]atrim=start=${sec(clip.trimInMs)}:duration=${durationS},asetpts=PTS-STARTPTS,` +
          `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${volume.toFixed(3)}[${audioLabels[i]}]`,
      );
    } else {
      const inputIdx = silentInputIndex.get(i)!;
      filterParts.push(`[${inputIdx}:a]atrim=duration=${durationS},asetpts=PTS-STARTPTS,volume=${volume.toFixed(3)}[${audioLabels[i]}]`);
    }
  });

  if (plan.clips.length > 1) {
    const interleaved = plan.clips.map((_, i) => `[${videoLabels[i]}][${audioLabels[i]}]`).join("");
    filterParts.push(`${interleaved}concat=n=${plan.clips.length}:v=1:a=1[vout][aout]`);
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-r", String(plan.fps));

  const { crf, audioBitrate } = QUALITY_PRESETS[plan.quality];
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", audioBitrate);
  args.push("-movflags", "+faststart", "-y", plan.outputPath);

  return args;
}

// Pure helpers for planning a render — deliberately kept free of any file
// I/O or process spawning so the logic (dimensions, contiguity, the
// filter_complex graph) can be unit tested without a real ffmpeg binary.

const ASPECT_RATIOS: Record<string, number> = {
  RATIO_16_9: 16 / 9,
  RATIO_9_16: 9 / 16,
  RATIO_1_1: 1,
  RATIO_4_5: 4 / 5,
  RATIO_21_9: 21 / 9,
};

function evenize(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function computeDimensions(
  aspectRatio: string,
  resolution: "R720P" | "R1080P",
  customWidth?: number | null,
  customHeight?: number | null,
): { width: number; height: number } {
  if (aspectRatio === "CUSTOM" && customWidth && customHeight) {
    return { width: evenize(customWidth), height: evenize(customHeight) };
  }
  const ratio = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS.RATIO_16_9;
  const shortEdge = resolution === "R1080P" ? 1080 : 720;
  if (ratio >= 1) {
    return { width: evenize(shortEdge * ratio), height: evenize(shortEdge) };
  }
  return { width: evenize(shortEdge), height: evenize(shortEdge / ratio) };
}

export interface ContiguityItem {
  startMs: number;
  durationMs: number;
}

// Gaps (needs a filler track we don't build yet) and overlaps (needs
// layering we don't build yet) are both out of scope for this render pass —
// give the user a clear reason instead of silently producing wrong output.
export function checkContiguous(items: ContiguityItem[]): { ok: true } | { ok: false; reason: string } {
  if (items.length === 0) return { ok: false, reason: "The track has no clips." };
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  if (sorted[0].startMs !== 0) {
    return { ok: false, reason: "The first clip must start at 0:00 — close the gap before exporting." };
  }
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].startMs + sorted[i - 1].durationMs;
    if (sorted[i].startMs > prevEnd) {
      return { ok: false, reason: `There's a gap on the timeline around ${(prevEnd / 1000).toFixed(1)}s — close it before exporting.` };
    }
    if (sorted[i].startMs < prevEnd) {
      return { ok: false, reason: `Clips overlap around ${(sorted[i].startMs / 1000).toFixed(1)}s — overlapping clips aren't supported yet.` };
    }
  }
  return { ok: true };
}

export interface VideoSegment {
  localPath: string;
  kind: "video" | "image";
  trimInMs: number;
  durationMs: number;
}

export interface AudioSegment {
  localPath: string;
  trimInMs: number;
  durationMs: number;
}

export interface RenderPlan {
  video: VideoSegment[];
  audio: AudioSegment[];
  width: number;
  height: number;
  fps: number;
  outputPath: string;
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

export function buildFfmpegArgs(plan: RenderPlan): string[] {
  if (plan.video.length === 0) throw new Error("A render plan needs at least one video segment");

  const args: string[] = [];

  for (const seg of plan.video) {
    if (seg.kind === "image") {
      // A still image has no duration of its own — loop it and cap it at
      // the input level so the filter graph below sees a real video stream.
      args.push("-loop", "1", "-t", sec(seg.durationMs), "-i", seg.localPath);
    } else {
      args.push("-i", seg.localPath);
    }
  }
  for (const seg of plan.audio) {
    args.push("-i", seg.localPath);
  }

  const filterParts: string[] = [];
  const videoLabels: string[] = [];
  plan.video.forEach((seg, i) => {
    const label = `v${i}`;
    filterParts.push(
      `[${i}:v]trim=start=${sec(seg.trimInMs)}:duration=${sec(seg.durationMs)},setpts=PTS-STARTPTS,` +
        `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,` +
        `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${plan.fps}[${label}]`,
    );
    videoLabels.push(`[${label}]`);
  });
  filterParts.push(`${videoLabels.join("")}concat=n=${plan.video.length}:v=1:a=0[vout]`);

  const audioLabels: string[] = [];
  const audioInputOffset = plan.video.length;
  plan.audio.forEach((seg, i) => {
    const inputIndex = audioInputOffset + i;
    const label = `a${i}`;
    filterParts.push(`[${inputIndex}:a]atrim=start=${sec(seg.trimInMs)}:duration=${sec(seg.durationMs)},asetpts=PTS-STARTPTS[${label}]`);
    audioLabels.push(`[${label}]`);
  });
  if (plan.audio.length > 0) {
    filterParts.push(`${audioLabels.join("")}concat=n=${plan.audio.length}:v=0:a=1[aout]`);
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]");
  args.push("-r", String(plan.fps));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");

  if (plan.audio.length > 0) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-shortest");
  }

  args.push("-movflags", "+faststart", "-y", plan.outputPath);
  return args;
}

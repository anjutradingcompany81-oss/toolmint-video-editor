// Pure helpers for planning a render — deliberately kept free of any file
// I/O or process spawning so the logic (dimensions, contiguity, the
// filter_complex graph) can be unit tested without a real ffmpeg binary.
// (DEFAULT_FONT_PATH is a resolved constant, not I/O — require.resolve just
// walks node_modules, it doesn't touch the font file itself.)

import { dirname, join } from "path";

// Bundled so text overlays render identically regardless of what fonts (if
// any) happen to be installed on the host — matters most on a bare Linux
// prod server, which usually has none. Dependency-free npm package shipping
// raw .ttf files (most font packages ship woff/woff2 only, which this
// ffmpeg build's libfreetype may not read).
export const DEFAULT_FONT_PATH = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf", "DejaVuSans.ttf");

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

// Gaps (needs a filler track we don't build yet) are out of scope — give the
// user a clear reason instead of silently producing wrong output. A bounded
// overlap is no longer an error: it's a transition (see buildFfmpegArgs's
// xfade/acrossfade chaining), as long as it doesn't consume an entire clip.
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
    const overlapMs = prevEnd - sorted[i].startMs;
    if (overlapMs > 0 && (overlapMs >= sorted[i - 1].durationMs || overlapMs >= sorted[i].durationMs)) {
      return {
        ok: false,
        reason: `The transition around ${(sorted[i].startMs / 1000).toFixed(1)}s is longer than one of the clips it's between — shorten it.`,
      };
    }
  }
  return { ok: true };
}

export type TransitionType = "fade" | "wipeleft" | "wiperight" | "slideup";

export interface VideoSegment {
  localPath: string;
  kind: "video" | "image";
  trimInMs: number;
  durationMs: number;
  // How much this segment overlaps the previous one — 0 means a hard cut.
  // Meaningless (ignored) on the first segment, which has no predecessor.
  transitionInMs: number;
  transitionType: TransitionType;
}

export interface AudioSegment {
  localPath: string;
  trimInMs: number;
  durationMs: number;
  transitionInMs: number;
}

// content is pre-written to textFilePath (by the caller, which already does
// file I/O for downloading source media) rather than passed as a string and
// inlined into the filter here — ffmpeg drawtext's inline-text escaping
// rules are notoriously fragile (colons, quotes, percent signs all need
// different treatment), and a text file sidesteps nearly all of it. Only
// the path itself needs escaping, not arbitrary user content.
export interface TextOverlay {
  textFilePath: string;
  startMs: number;
  durationMs: number;
  fontSize: number;
  color: string; // #rrggbb
  x: number;
  y: number;
  opacity: number;
}

export interface RenderPlan {
  video: VideoSegment[];
  audio: AudioSegment[];
  text: TextOverlay[];
  width: number;
  height: number;
  fps: number;
  outputPath: string;
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

// ffmpeg's filtergraph parser treats ':' as an option separator and '\' as
// its escape character, so a raw Windows path (drive-letter colon,
// backslash separators) breaks filter parsing unless normalized first.
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function hexToFfmpegColor(hex: string): string {
  return `0x${hex.slice(1)}`;
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
  // "vout" directly when there's only one segment (nothing to combine);
  // otherwise each segment gets its own v0/v1/... label and a combining step
  // below (plain concat, or an xfade chain when a transition is present)
  // produces "vout".
  const videoLabels = plan.video.map((_, i) => (plan.video.length === 1 ? "vout" : `v${i}`));
  plan.video.forEach((seg, i) => {
    filterParts.push(
      `[${i}:v]trim=start=${sec(seg.trimInMs)}:duration=${sec(seg.durationMs)},setpts=PTS-STARTPTS,` +
        `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,` +
        `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${plan.fps}[${videoLabels[i]}]`,
    );
  });

  if (plan.video.length > 1) {
    const hasTransitions = plan.video.slice(1).some((seg) => seg.transitionInMs > 0);
    if (!hasTransitions) {
      filterParts.push(`${videoLabels.map((l) => `[${l}]`).join("")}concat=n=${plan.video.length}:v=1:a=0[vout]`);
    } else {
      // xfade takes each clip's *full* individual duration and works out the
      // overlap itself from `offset`/`duration` — chaining it means tracking
      // the cumulative duration of the merged-so-far stream (which shrinks
      // by each transition's length as it's applied) to compute the next
      // offset, not just summing raw clip durations.
      let chainLabel = videoLabels[0];
      let cumulativeMs = plan.video[0].durationMs;
      for (let i = 1; i < plan.video.length; i++) {
        const seg = plan.video[i];
        const outLabel = i === plan.video.length - 1 ? "vout" : `vxf${i}`;
        const offsetMs = Math.max(0, cumulativeMs - seg.transitionInMs);
        filterParts.push(
          `[${chainLabel}][${videoLabels[i]}]xfade=transition=${seg.transitionType}:duration=${sec(seg.transitionInMs)}:offset=${sec(offsetMs)}[${outLabel}]`,
        );
        chainLabel = outLabel;
        cumulativeMs = cumulativeMs + seg.durationMs - seg.transitionInMs;
      }
    }
  }

  // Each overlay is its own drawtext link in the chain, independently gated
  // by `enable`, so overlapping text items (unlike video/audio clips) just
  // stack — no contiguity requirement.
  let finalVideoLabel = "vout";
  plan.text.forEach((overlay, i) => {
    const inLabel = finalVideoLabel;
    const outLabel = `vtxt${i}`;
    const startS = sec(overlay.startMs);
    const endS = sec(overlay.startMs + overlay.durationMs);
    filterParts.push(
      `[${inLabel}]drawtext=fontfile='${escapeFilterPath(DEFAULT_FONT_PATH)}':textfile='${escapeFilterPath(overlay.textFilePath)}':` +
        `reload=0:fontsize=${overlay.fontSize}:fontcolor=${hexToFfmpegColor(overlay.color)}@${overlay.opacity}:` +
        `x=(w-text_w)/2+${Math.round(overlay.x)}:y=(h-text_h)/2+${Math.round(overlay.y)}:` +
        `enable='between(t,${startS},${endS})'[${outLabel}]`,
    );
    finalVideoLabel = outLabel;
  });

  const audioLabels = plan.audio.map((_, i) => (plan.audio.length === 1 ? "aout" : `a${i}`));
  const audioInputOffset = plan.video.length;
  plan.audio.forEach((seg, i) => {
    const inputIndex = audioInputOffset + i;
    filterParts.push(`[${inputIndex}:a]atrim=start=${sec(seg.trimInMs)}:duration=${sec(seg.durationMs)},asetpts=PTS-STARTPTS[${audioLabels[i]}]`);
  });

  if (plan.audio.length > 1) {
    const hasAudioTransitions = plan.audio.slice(1).some((seg) => seg.transitionInMs > 0);
    if (!hasAudioTransitions) {
      filterParts.push(`${audioLabels.map((l) => `[${l}]`).join("")}concat=n=${plan.audio.length}:v=0:a=1[aout]`);
    } else {
      // acrossfade needs no offset like xfade does — it always fades the
      // tail of stream1 into the head of stream2 over `d` seconds, which is
      // exactly right when chained: at each step, stream1's tail is the
      // tail of whatever clip was most recently appended.
      let chainLabel = audioLabels[0];
      for (let i = 1; i < plan.audio.length; i++) {
        const seg = plan.audio[i];
        const outLabel = i === plan.audio.length - 1 ? "aout" : `axf${i}`;
        filterParts.push(`[${chainLabel}][${audioLabels[i]}]acrossfade=d=${sec(seg.transitionInMs)}[${outLabel}]`);
        chainLabel = outLabel;
      }
    }
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", `[${finalVideoLabel}]`);
  args.push("-r", String(plan.fps));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");

  if (plan.audio.length > 0) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "160k", "-shortest");
  }

  args.push("-movflags", "+faststart", "-y", plan.outputPath);
  return args;
}

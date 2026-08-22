// Pure helpers for planning a multitrack render — no file I/O or process
// spawning, so the filter-graph logic can be unit tested without a real
// ffmpeg binary.
//
// Model: a black/silent base canvas spanning the whole project duration,
// with every visual clip (video or overlay kind) composited onto it via a
// chain of `overlay` filters in ascending track order (lower order =
// bottom), and every audio-bearing clip mixed onto a silent base track via
// `amix`. Each clip's stream is time-shifted (`setpts`/`adelay`) so it
// lines up with its own absolute `startMs` on the timeline, then gated
// with `enable='between(t,...)'` (video) so it's only visible during its
// own window — this is what makes independent, overlapping tracks possible
// at all, unlike the old single-track "just concatenate everything" model.
//
// Deliberately not yet in this filter graph (later phases, not silently
// faked): clip rotation, chroma key, masks, transitions between clips, and
// burned-in text — text-kind clips are accepted by the schema but ignored
// by the renderer until the text-rendering phase lands.

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

// The canvas takes its shape from the base (lowest-order, "video" kind)
// clip's own source dimensions — every other visual clip is scaled to fit
// within it rather than distorted.
export function computeDimensions(resolution: Resolution, baseClipWidth: number, baseClipHeight: number): { width: number; height: number } {
  const ratio = baseClipWidth > 0 && baseClipHeight > 0 ? baseClipWidth / baseClipHeight : 16 / 9;

  if (resolution === "ORIGINAL") {
    return { width: evenize(baseClipWidth || 1280), height: evenize(baseClipHeight || 720) };
  }

  const shortEdge = ASPECT_STANDARD_SHORT_EDGE[resolution];
  return ratio >= 1 ? { width: evenize(shortEdge * ratio), height: evenize(shortEdge) } : { width: evenize(shortEdge), height: evenize(shortEdge / ratio) };
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

export function playableDurationMs(clip: { sourceDurationMs: number; trimInMs: number; trimOutMs: number }): number {
  return Math.max(MIN_CLIP_DURATION_MS, clip.sourceDurationMs - clip.trimInMs - clip.trimOutMs);
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export interface VisualClipSegment {
  localPath: string;
  kind: "video" | "overlay";
  // Compositing order across all visual tracks — lower renders first
  // (i.e. underneath), matching Track.order.
  trackOrder: number;
  startMs: number;
  durationMs: number;
  trimInMs: number;
  sourceWidth: number;
  sourceHeight: number;
  transform: Transform;
  // A still image (e.g. a logo) decodes to exactly one frame, so without
  // `-loop 1` bounded by `-t` it would appear for a single frame instead of
  // its clip's whole span. Absent/false for time-based sources.
  isStillImage?: boolean;
}

// AI Repetitive Voice Remover, "audio-only correction": a sub-range of
// this clip's own audio (in the clip's *local* timeline coordinates —
// [0, durationMs)) that should play room tone instead of the real source
// audio, e.g. because it was AI-detected (or user-confirmed) as
// accidentally duplicated speech. `roomToneSource*Ms` are in *source*
// coordinates (same space as trimInMs) — a quiet, non-speech reference
// clip elsewhere in the same file that gets looped to fill the gap.
// Undefined when no clean reference was found at detection time, in
// which case the renderer falls back to soft synthesized ambience.
export interface AudioPatchSegment {
  startMs: number;
  endMs: number;
  roomToneSourceStartMs?: number;
  roomToneSourceEndMs?: number;
}

export interface AudioClipSegment {
  localPath: string;
  startMs: number;
  durationMs: number;
  trimInMs: number;
  sourceDurationMs: number;
  hasAudio: boolean;
  volume: number;
  audioPatches: AudioPatchSegment[];
}

// Short fade in/out applied at every patch boundary instead of a hard cut
// — for a "replace this sub-range with different content" edit (as
// opposed to blending two independent clips), a fade in/out pair around
// the boundary reads the same as a crossfade to the ear while keeping the
// clip's total duration exactly unchanged (a true multi-segment acrossfade
// chain eats a little duration at every join, which would then need
// compensating padding — not worth the fragility here). This is what the
// product spec calls "crossfade correction": short fades that prevent
// clicks/pops at every room-tone patch boundary.
const PATCH_FADE_MS = 60;

// Builds one clip's own audio branch, honoring any audioPatches by
// splicing room-tone (or, absent a reference, soft synthesized ambience)
// over the patched sub-ranges and concatenating back to the clip's exact
// original duration — every other clip's timing is computed from that
// duration, so a patch must never change it. Returns the finished labeled
// segment ready to be volume/delay-adjusted the same way for every clip,
// patched or not.
export function buildClipAudioFilterChain(
  clip: Pick<AudioClipSegment, "trimInMs" | "durationMs" | "audioPatches">,
  inputIndex: number,
  labelPrefix: string,
): { filterLines: string[]; outputLabel: string } {
  if (clip.audioPatches.length === 0) {
    const label = `${labelPrefix}src`;
    return {
      filterLines: [`[${inputIndex}:a]atrim=start=${sec(clip.trimInMs)}:duration=${sec(clip.durationMs)},asetpts=PTS-STARTPTS[${label}]`],
      outputLabel: label,
    };
  }

  const patches = [...clip.audioPatches].sort((a, b) => a.startMs - b.startMs);
  type Segment = { kind: "keep" | "patch"; startMs: number; endMs: number; patch?: AudioPatchSegment };
  const segments: Segment[] = [];
  let cursor = 0;
  for (const patch of patches) {
    if (patch.startMs > cursor) segments.push({ kind: "keep", startMs: cursor, endMs: patch.startMs });
    segments.push({ kind: "patch", startMs: patch.startMs, endMs: patch.endMs, patch });
    cursor = patch.endMs;
  }
  if (cursor < clip.durationMs) segments.push({ kind: "keep", startMs: cursor, endMs: clip.durationMs });

  const filterLines: string[] = [];
  const segmentLabels: string[] = [];

  segments.forEach((segment, i) => {
    const label = `${labelPrefix}seg${i}`;
    const durationMs = segment.endMs - segment.startMs;
    const fadeMs = Math.min(PATCH_FADE_MS, Math.floor(durationMs / 2));
    const fadeBeforePatch = segment.kind === "keep" && segments[i + 1]?.kind === "patch";
    const fadeAfterPatch = segment.kind === "keep" && segments[i - 1]?.kind === "patch";

    let chain: string;
    if (segment.kind === "keep") {
      chain = `[${inputIndex}:a]atrim=start=${sec(clip.trimInMs + segment.startMs)}:duration=${sec(durationMs)},asetpts=PTS-STARTPTS`;
    } else {
      const patch = segment.patch!;
      if (patch.roomToneSourceStartMs != null && patch.roomToneSourceEndMs != null && patch.roomToneSourceEndMs > patch.roomToneSourceStartMs) {
        const refDurationMs = patch.roomToneSourceEndMs - patch.roomToneSourceStartMs;
        chain =
          `[${inputIndex}:a]atrim=start=${sec(patch.roomToneSourceStartMs)}:duration=${sec(refDurationMs)},asetpts=PTS-STARTPTS,` +
          `aloop=loop=-1:size=2147483647,atrim=duration=${sec(durationMs)},asetpts=PTS-STARTPTS`;
      } else {
        // No clean room-tone reference found at detection time — fall
        // back to very soft filtered noise rather than a hard digital
        // silence, so the correction doesn't create an unnatural dead gap.
        chain = `anoisesrc=color=pink:duration=${sec(durationMs)}:sample_rate=48000:amplitude=0.02,aformat=channel_layouts=stereo`;
      }
    }
    if (fadeBeforePatch || segment.kind === "patch") chain += `,afade=t=out:st=${sec(durationMs - fadeMs)}:d=${sec(fadeMs)}`;
    if (fadeAfterPatch || segment.kind === "patch") chain += `,afade=t=in:st=0:d=${sec(fadeMs)}`;

    filterLines.push(`${chain}[${label}]`);
    segmentLabels.push(label);
  });

  const outputLabel = `${labelPrefix}src`;
  if (segmentLabels.length === 1) {
    // A single segment can only happen if the whole clip is one patch —
    // still needs the standard label handed back to the caller, no concat
    // required.
    filterLines.push(`[${segmentLabels[0]}]anull[${outputLabel}]`);
  } else {
    filterLines.push(`${segmentLabels.map((l) => `[${l}]`).join("")}concat=n=${segmentLabels.length}:v=0:a=1[${outputLabel}]`);
  }

  return { filterLines, outputLabel };
}

export interface MultitrackMergePlan {
  visualClips: VisualClipSegment[];
  audioClips: AudioClipSegment[];
  width: number;
  height: number;
  fps: number;
  totalDurationMs: number;
  quality: Quality;
  outputPath: string;
  // Set only when the project asks for burned-in captions: the path of an
  // .srt written to the work dir, already escaped for embedding in a
  // filter string, plus the ASS force_style to draw it with.
  burnedSubtitles?: { escapedPath: string; forceStyle: string };
}

export function buildMultitrackMergeArgs(plan: MultitrackMergePlan): string[] {
  if (plan.visualClips.length === 0) throw new Error("A merge plan needs at least one visual clip");

  const args: string[] = [];
  const totalSec = sec(plan.totalDurationMs);

  // Base canvas + base silence, indices 0 and 1 — every real source file
  // is appended after these two synthetic inputs. The silence is bounded
  // to the project's total duration with an input-level `-t` (anullsrc is
  // otherwise infinite) so it's safe to use as amix's `duration=first`
  // reference below.
  args.push("-f", "lavfi", "-i", `color=size=${plan.width}x${plan.height}:rate=${plan.fps}:duration=${totalSec}:color=black`);
  args.push("-f", "lavfi", "-t", totalSec, "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`);
  const BASE_VIDEO_INPUT = 0;
  const BASE_AUDIO_INPUT = 1;
  let nextInput = 2;

  const visualInputIndex: number[] = [];
  for (const clip of plan.visualClips) {
    // Input-level flags must come BEFORE the -i they apply to.
    if (clip.isStillImage) args.push("-loop", "1", "-t", sec(clip.durationMs));
    args.push("-i", clip.localPath);
    visualInputIndex.push(nextInput++);
  }
  const audioInputIndex: number[] = [];
  for (const clip of plan.audioClips) {
    args.push("-i", clip.localPath);
    audioInputIndex.push(nextInput++);
  }

  const filterParts: string[] = [];

  // Sort a *copy* — compositing order must follow track order, but callers
  // may hand clips in whatever order they were queried in.
  const orderedVisual = plan.visualClips
    .map((clip, i) => ({ clip, inputIndex: visualInputIndex[i] }))
    .sort((a, b) => a.clip.trackOrder - b.clip.trackOrder);

  orderedVisual.forEach(({ clip, inputIndex }, i) => {
    const durationS = sec(clip.durationMs);
    const startS = sec(clip.startMs);
    const label = `v${i}`;
    // "video" kind clips fit the whole canvas by default (scale=1 fills
    // it, matching the letterbox behavior of the old single-track
    // pipeline); "overlay" kind clips (e.g. a future logo) default to
    // their own natural pixel size instead — scale=1 should never mean
    // "cover the entire frame" for something meant to sit in a corner.
    const fitWidth = clip.kind === "video" ? plan.width : clip.sourceWidth || plan.width;
    const fitHeight = clip.kind === "video" ? plan.height : clip.sourceHeight || plan.height;
    const targetW = evenize(Math.round(fitWidth * clip.transform.scale));
    const targetH = evenize(Math.round(fitHeight * clip.transform.scale));

    filterParts.push(
      `[${inputIndex}:v]trim=start=${sec(clip.trimInMs)}:duration=${durationS},setpts=PTS-STARTPTS+${startS}/TB,` +
        `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,format=yuva420p,` +
        `colorchannelmixer=aa=${clip.transform.opacity.toFixed(3)}[${label}]`,
    );
  });

  // Overlay chain: base canvas, then each visual clip in order, each
  // gated to only show during its own [start,end) window.
  let compositeLabel = "base";
  filterParts.push(`[${BASE_VIDEO_INPUT}:v]null[${compositeLabel}]`);
  orderedVisual.forEach(({ clip }, i) => {
    const nextLabel = `comp${i}`;
    const startS = sec(clip.startMs);
    const endS = sec(clip.startMs + clip.durationMs);
    filterParts.push(
      `[${compositeLabel}][v${i}]overlay=x=${Math.round(clip.transform.x)}:y=${Math.round(clip.transform.y)}:` +
        `enable='between(t,${startS},${endS})'[${nextLabel}]`,
    );
    compositeLabel = nextLabel;
  });
  // Captions burn in last, on top of every composited clip and overlay, so
  // a logo can't cover them and they read against the final picture.
  const subtitleFilter = plan.burnedSubtitles
    ? `,subtitles='${plan.burnedSubtitles.escapedPath}':force_style='${plan.burnedSubtitles.forceStyle}'`
    : "";
  filterParts.push(`[${compositeLabel}]fps=${plan.fps},format=yuv420p${subtitleFilter}[vout]`);

  // Audio: base silence plus every audio-bearing clip (or a synthetic
  // silent segment for a clip whose source has no audio track), each
  // delayed to its own absolute start time, then mixed together.
  const audioLabels = [`${BASE_AUDIO_INPUT}:a`];
  plan.audioClips.forEach((clip, i) => {
    const inputIndex = audioInputIndex[i];
    const delayMs = Math.max(0, Math.round(clip.startMs));
    const label = `a${i}`;
    if (clip.hasAudio) {
      const { filterLines, outputLabel } = buildClipAudioFilterChain(clip, inputIndex, `a${i}_`);
      filterParts.push(...filterLines);
      filterParts.push(
        `[${outputLabel}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${clip.volume.toFixed(3)},` +
          `adelay=${delayMs}|${delayMs}[${label}]`,
      );
      audioLabels.push(label);
    }
    // A clip with no source audio contributes nothing beyond the base
    // silence — no need for a synthetic per-clip silent segment here the
    // way the old single-track pipeline needed one for `concat` (which
    // requires a uniform stream count per segment); `amix` has no such
    // requirement, it just mixes however many real inputs exist.
  });

  if (audioLabels.length === 1) {
    filterParts.push(`[${audioLabels[0]}]anull[aout]`);
  } else {
    // amix defaults to normalize=1 (auto-scales to avoid clipping as
    // inputs are added) — no manual volume compensation needed on top.
    const inputs = audioLabels.map((l) => `[${l}]`).join("");
    filterParts.push(`${inputs}amix=inputs=${audioLabels.length}:duration=first:dropout_transition=0[aout]`);
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-r", String(plan.fps));

  const { crf, audioBitrate } = QUALITY_PRESETS[plan.quality];
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", audioBitrate);
  args.push("-movflags", "+faststart", "-t", totalSec, "-y", plan.outputPath);

  return args;
}

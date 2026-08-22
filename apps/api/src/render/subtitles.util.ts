// Pure subtitle serialisation — no I/O, so the exact byte-level format
// (which players are strict about) is unit-testable without running ffmpeg
// or touching the filesystem.
import type { SubtitleCue, SubtitleStyle } from "../projects/composition.schema";

/** SRT wants `HH:MM:SS,mmm`; WebVTT wants the same with a `.` separator. */
function stamp(totalMs: number, msSeparator: "," | "."): string {
  const ms = Math.max(0, Math.round(totalMs));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

// Overlapping or out-of-order cues make players skip or flicker lines, and
// ffmpeg's subtitles filter silently drops some of them. Sorting and
// trimming any overlap to the next cue's start keeps output well-formed
// regardless of how the cues were edited.
function normalize(cues: SubtitleCue[]): SubtitleCue[] {
  const sorted = [...cues].filter((c) => c.text.trim().length > 0).sort((a, b) => a.startMs - b.startMs);
  return sorted.map((cue, i) => {
    const next = sorted[i + 1];
    const endMs = next && cue.endMs > next.startMs ? next.startMs : cue.endMs;
    return { ...cue, endMs: Math.max(cue.startMs + 1, endMs) };
  });
}

export function toSrt(cues: SubtitleCue[]): string {
  const normalized = normalize(cues);
  if (normalized.length === 0) return "";
  return (
    normalized
      .map((cue, i) => `${i + 1}\n${stamp(cue.startMs, ",")} --> ${stamp(cue.endMs, ",")}\n${cue.text.trim()}`)
      .join("\n\n") + "\n"
  );
}

export function toVtt(cues: SubtitleCue[]): string {
  const normalized = normalize(cues);
  const body = normalized
    .map((cue) => `${stamp(cue.startMs, ".")} --> ${stamp(cue.endMs, ".")}\n${cue.text.trim()}`)
    .join("\n\n");
  // The WEBVTT header is mandatory even when there are no cues.
  return body.length > 0 ? `WEBVTT\n\n${body}\n` : "WEBVTT\n";
}

// ffmpeg's subtitles filter styles via ASS, whose colours are &HBBGGRR —
// byte-reversed from the #RRGGBB the UI uses.
function toAssColor(hex: string): string {
  const clean = hex.replace("#", "");
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `&H${bb}${gg}${rr}`.toUpperCase();
}

/** `force_style` value for ffmpeg's subtitles filter. Alignment 2 = bottom-centre, 8 = top-centre. */
export function toForceStyle(style: SubtitleStyle): string {
  return [
    `FontSize=${style.fontSizePx}`,
    `PrimaryColour=${toAssColor(style.colorHex)}`,
    `OutlineColour=${toAssColor(style.outlineHex)}`,
    "BorderStyle=1",
    "Outline=2",
    "Shadow=0",
    `Alignment=${style.position === "TOP" ? 8 : 2}`,
  ].join(",");
}

// A subtitles filter path is embedded inside a filter_complex string, where
// `:` separates options, `'` quotes values and `\` escapes — and on Windows
// a drive letter contains a colon. Escaping is therefore not optional.
export function escapeSubtitlePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

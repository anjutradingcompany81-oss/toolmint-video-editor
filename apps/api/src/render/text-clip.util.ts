// Text (title/caption) clips, drawn with ffmpeg's `drawtext`.
//
// The timeline schema has accepted text clips since the v2 rebuild but the
// renderer ignored them, so a text clip could be saved, shown on the
// timeline, and then silently vanish from the export. This is the one
// place the data model promised something the export did not deliver.

/** Where a font lives on disk. Overridable so a different image can move them. */
export const LATIN_FONT_PATH = process.env.TEXT_FONT_LATIN ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
export const DEVANAGARI_FONT_PATH = process.env.TEXT_FONT_DEVANAGARI ?? "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf";

// U+0900-U+097F. DejaVu has no Devanagari glyphs at all, so Hindi drawn
// with it comes out as empty boxes - which reads as a broken feature
// rather than a missing font. Picking the font from the text itself means
// a Hindi title works without the user having to know any of this.
const DEVANAGARI_RANGE = /[\u0900-\u097F]/;

export function fontPathForText(text: string): string {
  return DEVANAGARI_RANGE.test(text) ? DEVANAGARI_FONT_PATH : LATIN_FONT_PATH;
}

/**
 * Escapes a path for use inside a filter option.
 *
 * A Windows drive letter ("C:\...") would otherwise end the option at its
 * colon, and a backslash is an escape character in filtergraph syntax.
 * Same problem, and same fix, as the subtitle path.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export interface TextClipSegment {
  /** Absolute path to a file holding the text. */
  textFilePath: string;
  /** Absolute path to the font to draw it with. */
  fontFilePath: string;
  fontSize: number;
  /** #RRGGBB. */
  colorHex: string;
  opacity: number;
  x: number;
  y: number;
  startMs: number;
  durationMs: number;
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

/**
 * One `drawtext` per clip, chained.
 *
 * The text is passed by FILE rather than inline. Inline text has to escape
 * colons, quotes, backslashes, percent signs and commas, and any one of
 * them appearing in a user's title would either corrupt the filter graph
 * or abort the render - and a title is exactly the place someone types an
 * apostrophe.
 */
export function buildDrawTextFilters(segments: TextClipSegment[]): string {
  return segments
    .filter((s) => s.durationMs > 0 && s.fontSize > 0)
    .map((s) => {
      const start = sec(s.startMs);
      const end = sec(s.startMs + s.durationMs);
      // 0xRRGGBB is drawtext's colour form, not the #RRGGBB the schema
      // stores; alpha rides along after the @.
      const color = `0x${s.colorHex.replace("#", "")}@${s.opacity.toFixed(3)}`;
      return [
        `drawtext=textfile='${escapeFilterPath(s.textFilePath)}'`,
        `fontfile='${escapeFilterPath(s.fontFilePath)}'`,
        `fontsize=${Math.round(s.fontSize)}`,
        `fontcolor=${color}`,
        `x=${Math.round(s.x)}`,
        `y=${Math.round(s.y)}`,
        // Gated to the clip's own window, or the title would sit over the
        // entire video instead of the span it occupies on the timeline.
        `enable='between(t,${start},${end})'`,
      ].join(":");
    })
    .join(",");
}

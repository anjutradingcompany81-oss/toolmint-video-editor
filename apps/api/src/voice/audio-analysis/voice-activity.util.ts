// Voice activity detection via ffmpeg's own `silencedetect` filter — no
// separate VAD model dependency (Silero/WebRTC VAD are suggested in the
// product spec, not mandated; this reuses the bundled ffmpeg binary
// already on the critical path everywhere else in this app instead of
// adding a second ML runtime just for this one signal). Used to skip
// near-silent stretches of long videos before the much more expensive
// transcription step, and to give the "Detecting speech" progress stage
// real work behind it instead of being a cosmetic pause.
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

// Parses ffmpeg's `silencedetect` stderr text into silence windows — pure
// and independently testable from the process-spawning I/O below.
export function parseSilenceWindows(stderrText: string): { startMs: number; endMs: number }[] {
  const starts: number[] = [];
  const windows: { startMs: number; endMs: number }[] = [];
  const startRe = /silence_start:\s*([\d.]+)/g;
  const endRe = /silence_end:\s*([\d.]+)/g;

  let match: RegExpExecArray | null;
  while ((match = startRe.exec(stderrText))) starts.push(Math.round(parseFloat(match[1]) * 1000));
  let i = 0;
  while ((match = endRe.exec(stderrText))) {
    const endMs = Math.round(parseFloat(match[1]) * 1000);
    const startMs = starts[i++] ?? 0;
    windows.push({ startMs, endMs });
  }
  return windows;
}

// Inverts silence windows (within [0, totalDurationMs)) into the speech
// regions worth transcribing, merging anything separated by less than
// minGapMs so a transcript segment doesn't get needlessly fragmented by a
// half-second pause mid-sentence.
export function speechRegionsFromSilence(
  silenceWindows: { startMs: number; endMs: number }[],
  totalDurationMs: number,
  minGapMs = 300,
): SpeechRegion[] {
  const sorted = [...silenceWindows].sort((a, b) => a.startMs - b.startMs);
  const raw: SpeechRegion[] = [];
  let cursor = 0;
  for (const silence of sorted) {
    if (silence.startMs > cursor) raw.push({ startMs: cursor, endMs: silence.startMs });
    cursor = Math.max(cursor, silence.endMs);
  }
  if (cursor < totalDurationMs) raw.push({ startMs: cursor, endMs: totalDurationMs });

  if (raw.length === 0) return [];
  const merged: SpeechRegion[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    if (raw[i].startMs - last.endMs < minGapMs) {
      last.endMs = raw[i].endMs;
    } else {
      merged.push(raw[i]);
    }
  }
  return merged;
}

export function detectSpeechRegions(filePath: string, totalDurationMs: number): Promise<SpeechRegion[]> {
  if (!ffmpegPath) return Promise.reject(new Error("No ffmpeg binary available for this platform/architecture"));
  const binaryPath = ffmpegPath;

  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", filePath, "-af", "silencedetect=noise=-30dB:d=0.3", "-f", "null", "-"];
    const proc = spawn(binaryPath, args);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (silencedetect) exited with code ${code}: ${stderr.slice(-500)}`));
      const silenceWindows = parseSilenceWindows(stderr);
      resolve(speechRegionsFromSilence(silenceWindows, totalDurationMs));
    });
  });
}

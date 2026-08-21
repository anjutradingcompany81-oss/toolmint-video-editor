import { spawn } from "child_process";
import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";

export interface DiarizationSegment {
  startMs: number;
  endMs: number;
  speaker: string;
}

const DIARIZATION_TIMEOUT_MS = 5 * 60_000;

// Speaker diarization runs as a one-shot Python subprocess
// (apps/api/python/diarize.py, pyannote.audio) rather than an in-process
// Node dependency — no pure-JS diarization model exists, and this keeps
// the heavy torch/pyannote install fully isolated from the rest of the
// Node stack (only paid for in the Docker image, only invoked when a
// scan actually runs). Speaker identity is used to *protect* against
// false positives (never flag the same line from two different
// characters as a mistake) — it is never required for the feature to
// work at all, so every failure mode here degrades to "speaker unknown
// for this file" instead of failing the scan.
@Injectable()
export class DiarizationService {
  private readonly logger = new Logger(DiarizationService.name);

  async diarize(filePath: string): Promise<DiarizationSegment[]> {
    const pythonBin = process.env.DIARIZATION_PYTHON_BIN ?? "python3";
    const scriptPath = join(__dirname, "..", "..", "..", "python", "diarize.py");

    try {
      const stdout = await this.run(pythonBin, [scriptPath, filePath]);
      const parsed = JSON.parse(stdout) as { segments?: DiarizationSegment[]; error?: string };
      if (parsed.error) {
        this.logger.warn(`Diarization unavailable: ${parsed.error}`);
        return [];
      }
      return parsed.segments ?? [];
    } catch (err) {
      this.logger.warn(`Diarization failed, continuing without speaker labels: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private run(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`diarization timed out after ${DIARIZATION_TIMEOUT_MS}ms`));
      }, DIARIZATION_TIMEOUT_MS);

      proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err); // e.g. ENOENT — python3 isn't installed/on PATH in this environment
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`diarize.py exited with code ${code}: ${stderr.slice(-500)}`));
        resolve(stdout.trim());
      });
    });
  }
}

// Assigns the speaker whose diarized turn covers the largest share of
// [startMs, endMs) — undefined when diarization produced nothing (or the
// range falls in a gap between turns), which the detector already treats
// as "unknown, don't use this to rule anything out".
export function speakerForRange(segments: DiarizationSegment[], startMs: number, endMs: number): string | undefined {
  let best: { speaker: string; overlapMs: number } | null = null;
  for (const seg of segments) {
    const overlapMs = Math.min(endMs, seg.endMs) - Math.max(startMs, seg.startMs);
    if (overlapMs <= 0) continue;
    if (!best || overlapMs > best.overlapMs) best = { speaker: seg.speaker, overlapMs };
  }
  return best?.speaker;
}

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// Waveform resolution is fixed regardless of clip length or timeline zoom —
// the timeline stretches/compresses this same peak array to fit whatever
// pixel width the clip currently occupies, same as every other NLE's
// cached-waveform approach. 200 min/max pairs is enough detail to not look
// flat even for a 30-minute clip, and small enough to store inline as JSON
// rather than needing a separate storage object.
const WAVEFORM_BUCKETS = 200;
// Downsampled before bucketing — the waveform's shape doesn't need the
// original sample rate, and decoding at 8kHz mono is dramatically faster
// and lighter than the source file for anything longer than a few seconds.
const PCM_SAMPLE_RATE = 8000;

export interface ProbedMedia {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  waveformPeaks: number[] | null;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);

  // Writes the buffer to a temp file (ffprobe/ffmpeg need a real path, not
  // an in-memory buffer) and cleans it up unconditionally, mirroring the
  // temp-workdir pattern render.processor.ts already uses for the same reason.
  async probe(buffer: Buffer, extensionHint: string, attemptWaveform: boolean): Promise<ProbedMedia> {
    const workDir = await mkdtemp(join(tmpdir(), "toolmint-probe-"));
    const filePath = join(workDir, `source.${extensionHint}`);
    try {
      await writeFile(filePath, buffer);
      const [info, waveformPeaks] = await Promise.all([
        this.probeFormat(filePath).catch((err) => {
          this.logger.warn(`ffprobe failed: ${err instanceof Error ? err.message : err}`);
          return { durationMs: null, width: null, height: null };
        }),
        // Images/documents can't have an audio track — skip the attempt
        // rather than let it fail-and-be-caught every time.
        attemptWaveform
          ? this.extractWaveformPeaks(filePath).catch((err) => {
              this.logger.warn(`waveform extraction failed: ${err instanceof Error ? err.message : err}`);
              return null;
            })
          : Promise.resolve(null),
      ]);
      return { ...info, waveformPeaks };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private probeFormat(filePath: string): Promise<Omit<ProbedMedia, "waveformPeaks">> {
    return new Promise((resolve, reject) => {
      const args = ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath];
      const proc = spawn(ffprobeStatic.path, args);
      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
        try {
          const parsed = JSON.parse(stdout) as FfprobeOutput;
          const durationS = parsed.format?.duration ? Number(parsed.format.duration) : null;
          const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
          resolve({
            durationMs: durationS != null && Number.isFinite(durationS) ? Math.round(durationS * 1000) : null,
            width: videoStream?.width ?? null,
            height: videoStream?.height ?? null,
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  // Extracts raw mono PCM and reduces it to min/max pairs per bucket.
  // Video files with no audio stream reject cleanly (caught by the caller)
  // rather than producing a fake flat waveform.
  private extractWaveformPeaks(filePath: string): Promise<number[]> {
    if (!ffmpegPath) throw new Error("No ffmpeg binary available for this platform/architecture");
    const binaryPath = ffmpegPath;
    return new Promise((resolve, reject) => {
      const args = ["-v", "error", "-i", filePath, "-ac", "1", "-ar", String(PCM_SAMPLE_RATE), "-f", "s16le", "pipe:1"];
      const proc = spawn(binaryPath, args);
      const chunks: Buffer[] = [];
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        const pcm = Buffer.concat(chunks);
        const sampleCount = Math.floor(pcm.length / 2);
        if (sampleCount === 0) return reject(new Error("No audio samples decoded"));

        const samplesPerBucket = Math.max(1, Math.floor(sampleCount / WAVEFORM_BUCKETS));
        const peaks: number[] = [];
        for (let bucket = 0; bucket < WAVEFORM_BUCKETS; bucket++) {
          const start = bucket * samplesPerBucket;
          const end = bucket === WAVEFORM_BUCKETS - 1 ? sampleCount : start + samplesPerBucket;
          let min = 0;
          let max = 0;
          for (let i = start; i < end && i < sampleCount; i++) {
            const sample = pcm.readInt16LE(i * 2) / 32768;
            if (sample < min) min = sample;
            if (sample > max) max = sample;
          }
          peaks.push(Math.round(min * 1000) / 1000, Math.round(max * 1000) / 1000);
        }
        resolve(peaks);
      });
    });
  }
}

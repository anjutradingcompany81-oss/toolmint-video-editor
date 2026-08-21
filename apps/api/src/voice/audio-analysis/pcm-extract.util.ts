// Decodes an audio/video file into raw mono PCM via the same bundled
// ffmpeg binary media-probe.service.ts already uses for waveform peaks —
// this is the one I/O seam the AI Repetitive Voice Remover's otherwise-
// pure analysis code (Whisper, MFCC fingerprinting, energy envelopes) all
// sits on top of.
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

export interface PcmResult {
  samples: Float32Array;
  sampleRate: number;
}

// Extracts the whole file (or an optional [startMs, endMs) window) as
// mono Float32 PCM at the given sample rate. 16kHz is what Whisper
// expects; MFCC fingerprinting is fine at whatever rate the caller
// already has decoded, so it doesn't need a second decode pass.
export function extractPcm(filePath: string, sampleRate: number, window?: { startMs: number; endMs: number }): Promise<PcmResult> {
  if (!ffmpegPath) return Promise.reject(new Error("No ffmpeg binary available for this platform/architecture"));
  const binaryPath = ffmpegPath;

  return new Promise((resolve, reject) => {
    const args: string[] = ["-v", "error"];
    if (window) args.push("-ss", (window.startMs / 1000).toFixed(3));
    args.push("-i", filePath);
    if (window) args.push("-t", ((window.endMs - window.startMs) / 1000).toFixed(3));
    args.push("-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1");

    const proc = spawn(binaryPath, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      const buffer = Buffer.concat(chunks);
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
      // Float32Array backed by a Buffer's pool-allocated memory can be
      // reclaimed/reused once the Buffer is garbage collected — copy out
      // to an independent array so it safely outlives this function.
      resolve({ samples: Float32Array.from(samples), sampleRate });
    });
  });
}

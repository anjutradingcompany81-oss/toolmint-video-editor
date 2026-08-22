// Places each synthesized line at its timeline position and sums them
// into one continuous voice-over track.
//
// Mixing happens here in plain arithmetic rather than through an ffmpeg
// adelay/amix graph, because the providers already hand back raw samples:
// going out to a subprocess would mean encoding every line to a temp file
// purely to have ffmpeg add them back together. It also makes the part
// most likely to be subtly wrong - sample offsets, overlap, clipping -
// directly testable, instead of only observable by listening to an export.

export interface SynthesizedLine {
  lineId: string;
  /** Timeline position, in ms, where this line should begin speaking. */
  startMs: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface LineTiming {
  lineId: string;
  startMs: number;
  /** Measured length of the synthesized speech - only knowable after the fact. */
  durationMs: number;
  endMs: number;
  /**
   * How far this line runs past the start of the next one, or 0 when it
   * fits. Overlapping speech is still mixed (it is sometimes wanted, and
   * silently moving the user's line would be worse), but the UI needs to
   * be able to point it out.
   */
  overlapsNextByMs: number;
}

export interface MixResult {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  timings: LineTiming[];
  /** True if summing overlapping lines had to be clamped - i.e. audible distortion. */
  clipped: boolean;
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

export function samplesToMs(count: number, sampleRate: number): number {
  return Math.round((count / sampleRate) * 1000);
}

/**
 * Linear resample to `targetRate`. Providers differ (the built-in models
 * emit 16kHz, ElevenLabs 24kHz), and summing buffers of different rates
 * without conversion would play them at the wrong speed and pitch.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const lower = Math.floor(src);
    const upper = Math.min(lower + 1, samples.length - 1);
    const frac = src - lower;
    out[i] = samples[lower]! * (1 - frac) + samples[upper]! * frac;
  }
  return out;
}

export function mixVoiceOverTrack(lines: SynthesizedLine[], targetSampleRate: number): MixResult {
  if (lines.length === 0) {
    return { samples: new Float32Array(0), sampleRate: targetSampleRate, durationMs: 0, timings: [], clipped: false };
  }

  // Sort by position so overlap is measured against the line that
  // actually comes next on the timeline, not the next one in array order.
  const ordered = [...lines].sort((a, b) => a.startMs - b.startMs);

  const prepared = ordered.map((line) => {
    const samples = resample(line.samples, line.sampleRate, targetSampleRate);
    // A negative startMs would index before the start of the buffer and
    // silently drop the beginning of the line.
    const startMs = Math.max(0, Math.round(line.startMs));
    return { lineId: line.lineId, startMs, samples, offset: msToSamples(startMs, targetSampleRate) };
  });

  const totalSamples = prepared.reduce((max, l) => Math.max(max, l.offset + l.samples.length), 0);
  const mixed = new Float32Array(totalSamples);

  let clipped = false;
  for (const line of prepared) {
    for (let i = 0; i < line.samples.length; i += 1) {
      const at = line.offset + i;
      const sum = mixed[at]! + line.samples[i]!;
      // Hard clamp. Overlapping speech can sum past full scale, and
      // letting it wrap would turn a mild overlap into a loud crackle.
      if (sum > 1 || sum < -1) clipped = true;
      mixed[at] = sum > 1 ? 1 : sum < -1 ? -1 : sum;
    }
  }

  const timings: LineTiming[] = prepared.map((line, index) => {
    const durationMs = samplesToMs(line.samples.length, targetSampleRate);
    const endMs = line.startMs + durationMs;
    const next = prepared[index + 1];
    return {
      lineId: line.lineId,
      startMs: line.startMs,
      durationMs,
      endMs,
      overlapsNextByMs: next ? Math.max(0, endMs - next.startMs) : 0,
    };
  });

  return { samples: mixed, sampleRate: targetSampleRate, durationMs: samplesToMs(totalSamples, targetSampleRate), timings, clipped };
}

/**
 * Wrap float samples in a 16-bit mono WAV container.
 *
 * Written by hand rather than pulled from a dependency because the header
 * is 44 fixed bytes and the encoders available all bring a native build
 * step with them. The result is handed to ffmpeg for mp3 encoding, so it
 * only has to be correct, not compact.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  // Everything after this field: the remaining 36 header bytes + payload.
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk length
  buffer.writeUInt16LE(1, 20); // format 1 = uncompressed PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    // Scale by 32767 rather than 32768 so +1.0 stays inside int16 range
    // instead of overflowing to -32768 - a full-scale sample would
    // otherwise flip sign and click.
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * bytesPerSample);
  }
  return buffer;
}

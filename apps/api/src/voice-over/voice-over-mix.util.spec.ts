import { decodePcmS16le } from "./tts/pcm.util";
import { encodeWav, mixVoiceOverTrack, msToSamples, resample, samplesToMs, type SynthesizedLine } from "./voice-over-mix.util";

const RATE = 16000;

function tone(lengthMs: number, value = 0.5, rate = RATE): Float32Array {
  return new Float32Array(msToSamples(lengthMs, rate)).fill(value);
}

function line(lineId: string, startMs: number, lengthMs: number, value = 0.5, sampleRate = RATE): SynthesizedLine {
  return { lineId, startMs, samples: tone(lengthMs, value, sampleRate), sampleRate };
}

describe("mixVoiceOverTrack", () => {
  it("returns an empty track for an empty script rather than throwing", () => {
    const mix = mixVoiceOverTrack([], RATE);
    expect(mix.samples.length).toBe(0);
    expect(mix.durationMs).toBe(0);
    expect(mix.timings).toEqual([]);
  });

  it("places a line at its timeline position, leaving silence before it", () => {
    const mix = mixVoiceOverTrack([line("a", 1000, 500)], RATE);

    // Everything before 1s must be untouched silence - if the offset were
    // dropped the line would start at zero and drift out of sync with the
    // picture for the whole rest of the video.
    expect(mix.samples.slice(0, msToSamples(1000, RATE)).every((s) => s === 0)).toBe(true);
    expect(mix.samples[msToSamples(1000, RATE)]).toBeCloseTo(0.5);
    expect(mix.durationMs).toBe(1500);
  });

  it("measures each line's real duration and reports where one runs into the next", () => {
    // Second line starts at 1200ms but the first still has 800ms to go.
    const mix = mixVoiceOverTrack([line("a", 1000, 1000), line("b", 1200, 500)], RATE);

    expect(mix.timings).toEqual([
      { lineId: "a", startMs: 1000, durationMs: 1000, endMs: 2000, overlapsNextByMs: 800 },
      { lineId: "b", startMs: 1200, durationMs: 500, endMs: 1700, overlapsNextByMs: 0 },
    ]);
  });

  it("sums overlapping lines instead of letting the later one replace the earlier", () => {
    const mix = mixVoiceOverTrack([line("a", 0, 1000, 0.25), line("b", 500, 500, 0.25)], RATE);

    expect(mix.samples[0]).toBeCloseTo(0.25); // only "a"
    expect(mix.samples[msToSamples(500, RATE)]).toBeCloseTo(0.5); // both
    expect(mix.clipped).toBe(false);
  });

  it("clamps a summed overlap and flags it, rather than wrapping into a crackle", () => {
    const mix = mixVoiceOverTrack([line("a", 0, 1000, 0.9), line("b", 0, 1000, 0.9)], RATE);

    expect(mix.clipped).toBe(true);
    expect(Math.max(...mix.samples)).toBeLessThanOrEqual(1);
  });

  it("orders timings by timeline position, not by the order lines were passed in", () => {
    const mix = mixVoiceOverTrack([line("late", 5000, 100), line("early", 0, 100)], RATE);
    expect(mix.timings.map((t) => t.lineId)).toEqual(["early", "late"]);
  });

  it("measures overlap against the next line on the timeline, not the next in the array", () => {
    // Passed out of order on purpose: "a" overlaps "b", and only sorting
    // first makes that visible.
    const mix = mixVoiceOverTrack([line("b", 1000, 100), line("a", 500, 1000)], RATE);
    const a = mix.timings.find((t) => t.lineId === "a")!;
    expect(a.overlapsNextByMs).toBe(500);
  });

  it("treats a negative start as zero instead of writing before the buffer", () => {
    const mix = mixVoiceOverTrack([line("a", -500, 200)], RATE);
    expect(mix.timings[0]!.startMs).toBe(0);
    expect(mix.samples[0]).toBeCloseTo(0.5);
  });

  it("resamples a line recorded at another rate so it plays at the right speed", () => {
    // 500ms at 24kHz must still occupy 500ms once mixed at 16kHz.
    const mix = mixVoiceOverTrack([line("a", 0, 500, 0.5, 24000)], RATE);
    expect(mix.durationMs).toBe(500);
  });
});

describe("resample", () => {
  it("is a no-op when the rate already matches", () => {
    const input = tone(100);
    expect(resample(input, RATE, RATE)).toBe(input);
  });

  it("scales length by the rate ratio", () => {
    expect(resample(new Float32Array(16000), 16000, 24000).length).toBe(24000);
    expect(resample(new Float32Array(24000), 24000, 16000).length).toBe(16000);
  });

  it("preserves a constant signal's value across conversion", () => {
    const out = resample(new Float32Array(1000).fill(0.4), 16000, 24000);
    expect(out[500]).toBeCloseTo(0.4, 5);
  });
});

describe("encodeWav", () => {
  it("writes a header ffmpeg will accept, with lengths matching the payload", () => {
    const wav = encodeWav(tone(1000), RATE);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample

    const dataBytes = RATE * 2;
    expect(wav.readUInt32LE(40)).toBe(dataBytes);
    expect(wav.readUInt32LE(4)).toBe(36 + dataBytes);
    expect(wav.length).toBe(44 + dataBytes);
  });

  it("keeps full-scale samples in range instead of overflowing to the opposite sign", () => {
    const wav = encodeWav(Float32Array.from([1, -1]), RATE);
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
  });

  it("clamps out-of-range input rather than wrapping it", () => {
    const wav = encodeWav(Float32Array.from([2.5, -2.5]), RATE);
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
  });

  it("round-trips through the PCM decoder the cloud provider uses", () => {
    const original = Float32Array.from([0, 0.5, -0.5, 0.25]);
    const decoded = decodePcmS16le(encodeWav(original, RATE).subarray(44));
    decoded.forEach((sample, i) => expect(sample).toBeCloseTo(original[i]!, 3));
  });
});

describe("samplesToMs / msToSamples", () => {
  it("round-trips whole milliseconds", () => {
    expect(samplesToMs(msToSamples(1234, RATE), RATE)).toBe(1234);
  });
});

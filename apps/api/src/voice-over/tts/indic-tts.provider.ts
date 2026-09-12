import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { SynthesisRequest, SynthesisResult, TtsProvider, TtsReadiness, TtsVoice } from "./tts-provider";

// Speech from the Indic TTS sidecar (services/tts-indic).
//
// Two reasons this is a separate service rather than another model id in
// LocalTtsProvider. First, F5 is a PyTorch flow-matching model with its
// own vocoder and no realistic ONNX export, so transformers.js cannot run
// it. Second, and more importantly, the MMS checkpoints behind the
// built-in voices are CC-BY-NC: fine for a hobby project, not for a
// commercial product. The models here are CC-BY-4.0 and MIT.
//
// F5 conditions on a reference recording, so every voice is a clip plus
// its transcript sitting in the sidecar's voices/ directory. That is why
// this provider reports cloning as supported - handing it a recording of
// a particular person is the ordinary way to use it, not a special mode.
@Injectable()
export class IndicTtsProvider implements TtsProvider {
  readonly id = "indic";
  readonly label = "Indian languages (on this server)";
  readonly description =
    "Hindi speech from a model trained on Indian-language data, running on this server with no account or API key. Each voice is a reference recording, so you can add your own voice by dropping a clip and its transcript into the sidecar's voices folder.";
  readonly requiredEnvVar = "INDIC_TTS_URL";
  readonly supportsVoiceCloning = true;

  private readonly logger = new Logger(IndicTtsProvider.name);

  constructor(private readonly config: ConfigService) {}

  private baseUrl(): string | null {
    return this.config.get<string>("INDIC_TTS_URL")?.trim().replace(/\/+$/, "") || null;
  }

  readiness(): TtsReadiness {
    // Only the URL is checked, not whether the service answers. A
    // container that is still pulling model weights is starting, not
    // misconfigured, and reporting NEEDS_CONFIGURATION for it would send
    // the operator looking for a setting that is already correct.
    return this.baseUrl() ? "READY" : "NEEDS_CONFIGURATION";
  }

  async listVoices(): Promise<TtsVoice[]> {
    const base = this.baseUrl();
    if (!base) return [];
    try {
      const res = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = (await res.json()) as { voices?: TtsVoice[] };
      return body.voices ?? [];
    } catch (err) {
      // An empty picker is honest here: we genuinely don't know what this
      // service offers. Throwing would take down the whole provider list.
      this.logger.warn(`Could not list voices from the Indic TTS sidecar: ${String(err)}`);
      return [];
    }
  }

  async synthesize({ text, voiceId, fast }: SynthesisRequest): Promise<SynthesisResult> {
    const base = this.baseUrl();
    if (!base) throw new Error("Indic TTS is not configured on this server (INDIC_TTS_URL is not set)");

    const res = await fetch(`${base}/synthesise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Flow matching's step count is a direct speed/quality dial. 16
      // steps (half the sidecar's 32-step default) roughly halves preview
      // wait time; a short one-off audition doesn't need the last bit of
      // cleanliness a full 32 steps buys for audio that's actually kept.
      body: JSON.stringify(fast ? { text, voice: voiceId, steps: 16 } : { text, voice: voiceId }),
      // Flow matching on CPU is slow and a long line legitimately takes
      // minutes. Cutting it off early would look like a model failure.
      signal: AbortSignal.timeout(10 * 60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Indic TTS failed (${res.status}): ${detail.slice(0, 300) || res.statusText}`);
    }

    const sampleRate = Number(res.headers.get("X-Sample-Rate"));
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Indic TTS returned audio without a usable X-Sample-Rate header");
    }

    // Raw little-endian float32, matching what the sidecar documents and
    // what SynthesisResult wants, so there is no decode step here.
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
      throw new Error(`Indic TTS returned ${buf.byteLength} bytes, which is not whole float32 samples`);
    }
    const samples = new Float32Array(buf);

    // The sidecar already rejects silent output, but this provider is the
    // last point before the mixer and a silent track that reports success
    // is the worst outcome available, so it is checked on both sides.
    if (!samples.some((s) => s !== 0)) {
      throw new Error(`Indic TTS produced no audio for "${text.slice(0, 40)}"`);
    }

    return { samples, sampleRate };
  }
}

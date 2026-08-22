import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decodePcmS16le } from "./pcm.util";
import type { SynthesisRequest, SynthesisResult, TtsProvider, TtsReadiness, TtsVoice } from "./tts-provider";

const API_ROOT = "https://api.elevenlabs.io/v1";
// The one output format in their list that needs no decoding on our side:
// signed 16-bit little-endian PCM. Requesting mp3 would mean shelling out
// to ffmpeg per line purely to get back to samples the mixer can use.
const OUTPUT_FORMAT = "pcm_24000";
const SAMPLE_RATE = 24000;
const REQUEST_TIMEOUT_MS = 120_000;

// A real HTTP integration, not a stub - but it is inert without
// ELEVENLABS_API_KEY, and says so rather than pretending.
//
// This is the provider that makes the "use a voice from the video" part
// of voice over possible at all: a fixed local model has one speaker per
// language and physically cannot imitate a particular person. Cloning
// additionally needs speaker segments to clone FROM, which is why the
// service also checks that diarization is available before offering it.
@Injectable()
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = "elevenlabs";
  readonly label = "ElevenLabs";
  readonly description =
    "Cloud voices with a large voice library and voice cloning, including cloning a speaker from your own footage. Requires a paid ElevenLabs API key.";
  readonly requiredEnvVar = "ELEVENLABS_API_KEY";
  readonly supportsVoiceCloning = true;

  private readonly logger = new Logger(ElevenLabsTtsProvider.name);

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string | null {
    const key = this.config.get<string>("ELEVENLABS_API_KEY")?.trim();
    return key ? key : null;
  }

  readiness(): TtsReadiness {
    return this.apiKey() ? "READY" : "NEEDS_CONFIGURATION";
  }

  async listVoices(): Promise<TtsVoice[]> {
    const key = this.apiKey();
    if (!key) return [];
    try {
      const res = await fetch(`${API_ROOT}/voices`, {
        headers: { "xi-api-key": key },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`ElevenLabs voice list failed: ${res.status}`);
        return [];
      }
      const body = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
      return (body.voices ?? []).map((v) => ({
        id: v.voice_id,
        label: v.name,
        language: v.labels?.language ?? "multi",
        gender: normalizeGender(v.labels?.gender),
      }));
    } catch (err) {
      // A listing failure must not take down the whole provider list -
      // the other providers are still perfectly usable.
      this.logger.warn(`ElevenLabs voice list errored: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async synthesize({ text, voiceId }: SynthesisRequest): Promise<SynthesisResult> {
    const key = this.apiKey();
    if (!key) throw new Error("ElevenLabs is not configured on this server (ELEVENLABS_API_KEY is not set)");

    const res = await fetch(`${API_ROOT}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      // eleven_multilingual_v2 rather than the English-only model: this
      // editor's voice features are used on Hindi footage, and picking
      // the monolingual model would mispronounce it.
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Surface their message where there is one - "quota exceeded" and
      // "invalid voice" need very different responses from the user, and
      // a bare status code tells them neither.
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const samples = decodePcmS16le(Buffer.from(await res.arrayBuffer()));
    if (samples.length === 0) throw new Error("ElevenLabs returned an empty audio response");
    return { samples, sampleRate: SAMPLE_RATE };
  }
}

function normalizeGender(raw: string | undefined): TtsVoice["gender"] {
  if (raw === "male" || raw === "female") return raw;
  return raw ? "neutral" : undefined;
}

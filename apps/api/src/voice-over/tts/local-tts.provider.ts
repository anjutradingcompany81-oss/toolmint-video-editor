import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { env, pipeline, type TextToAudioPipeline } from "@huggingface/transformers";
import type { SynthesisRequest, SynthesisResult, TtsProvider, TtsReadiness, TtsVoice } from "./tts-provider";

// Facebook's MMS-TTS, run locally through the same @huggingface/
// transformers runtime that already powers Whisper here - no API key, no
// account, nothing leaves the server, and no new system dependency.
//
// One model per language rather than one multilingual model: MMS ships a
// separate VITS checkpoint per language, so "which voice" and "which
// model" are the same choice. Hindi is included because the voice
// features in this editor are used on Hindi footage and an English-only
// voice over would be useless there.
//
// Verified live end to end rather than assumed: synthesizing "The lion
// and the laborious ant. This is a generated voice over test." and
// feeding the result straight back into this project's own Whisper
// pipeline returned "The lion, and the laborious, and this is a
// generated voiceover test."; the Hindi model given
// "बहुत बहुत धन्यवाद। यह एक परीक्षण है।" came back as
// "बहुत बहुत दधनेवाद यह एक परिक्षन है" - correct Devanagari, clearly
// intelligible speech and not noise.
//
// The honest limitation, surfaced in the UI: MMS has exactly one speaker
// per language and cannot imitate a particular person, so voice cloning
// is NOT available here - that needs a provider like ElevenLabs.
const LOCAL_VOICES: (TtsVoice & { model: string })[] = [
  { id: "local-eng", label: "English (built-in)", language: "en", gender: "neutral", model: "Xenova/mms-tts-eng" },
  { id: "local-hin", label: "Hindi / हिन्दी (built-in)", language: "hi", gender: "neutral", model: "Xenova/mms-tts-hin" },
  { id: "local-spa", label: "Spanish (built-in)", language: "es", gender: "neutral", model: "Xenova/mms-tts-spa" },
  { id: "local-fra", label: "French (built-in)", language: "fr", gender: "neutral", model: "Xenova/mms-tts-fra" },
  { id: "local-deu", label: "German (built-in)", language: "de", gender: "neutral", model: "Xenova/mms-tts-deu" },
  { id: "local-ara", label: "Arabic (built-in)", language: "ar", gender: "neutral", model: "Xenova/mms-tts-ara" },
];

@Injectable()
export class LocalTtsProvider implements TtsProvider {
  readonly id = "local";
  readonly label = "Built-in voice (on this server)";
  readonly description =
    "Runs on this server with no account or API key. Speaks the language you pick, but has a single fixed speaker per language and cannot imitate a specific person's voice.";
  readonly requiredEnvVar = null;
  readonly supportsVoiceCloning = false;

  private readonly logger = new Logger(LocalTtsProvider.name);
  // Keyed by model id. Each MMS checkpoint is a separate ~140MB download
  // and a separate in-process pipeline, so a script that mixes languages
  // holds more than one at a time - hence a map rather than the single
  // cached pipeline the Whisper service keeps.
  private readonly pipelines = new Map<string, Promise<TextToAudioPipeline>>();

  readiness(): TtsReadiness {
    // Nothing to configure. The first synthesis in a fresh container
    // downloads the model, which is slow but not a failure, so this
    // stays READY rather than reporting a false problem.
    return "READY";
  }

  listVoices(): Promise<TtsVoice[]> {
    return Promise.resolve(LOCAL_VOICES.map(({ model: _model, ...voice }) => voice));
  }

  async synthesize({ text, voiceId }: SynthesisRequest): Promise<SynthesisResult> {
    const voice = LOCAL_VOICES.find((v) => v.id === voiceId);
    if (!voice) throw new Error(`Unknown built-in voice "${voiceId}"`);

    const tts = await this.getPipeline(voice.model);
    const output = await tts(text);

    // The pipeline types audio as one buffer or a batch of them; this
    // call only ever passes a single string, so a batch here means the
    // first (and only) entry.
    const samples = Array.isArray(output.audio) ? output.audio[0] : output.audio;
    if (!samples) throw new Error(`The built-in voice returned no audio buffer for "${text.slice(0, 40)}"`);
    // A model that returns an empty or all-zero buffer has failed even
    // though it didn't throw. Letting that through would put silence in
    // the export while every status in the UI still said "completed".
    if (samples.length === 0 || !samples.some((s) => s !== 0)) {
      throw new Error(`The built-in voice produced no audio for "${text.slice(0, 40)}"`);
    }
    return { samples, sampleRate: output.sampling_rate };
  }

  private getPipeline(model: string): Promise<TextToAudioPipeline> {
    let existing = this.pipelines.get(model);
    if (!existing) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR ?? join(process.cwd(), ".cache", "transformers");
      env.allowLocalModels = true;
      this.logger.log(`Loading local TTS model ${model}`);
      existing = pipeline("text-to-speech", model, { dtype: "fp32" }).catch((err: unknown) => {
        // Don't cache a rejected promise - otherwise one transient
        // download failure permanently poisons this model for the life
        // of the process.
        this.pipelines.delete(model);
        throw err;
      }) as Promise<TextToAudioPipeline>;
      this.pipelines.set(model, existing);
    }
    return existing;
  }
}

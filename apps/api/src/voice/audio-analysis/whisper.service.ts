import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { env, pipeline, Tensor, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { groupWordsIntoSegments, type TranscriptChunk, type WordTiming } from "./segment-transcript.util";
import { pickDetectionWindows, pickDominantLanguage } from "./language-detect.util";

const WHISPER_SAMPLE_RATE = 16000;

// Runs entirely locally (no external API calls, nothing leaves the
// server), CPU-only — this VPS has no GPU, so a smaller multilingual
// model is used to keep scan times tolerable rather than reaching for a
// larger, more accurate one.
//
// Specifically the "Xenova/" export, not "onnx-community/whisper-base" —
// confirmed live that the onnx-community export throws "Model outputs
// must contain cross attentions to extract timestamps" for word-level
// timestamps (it wasn't exported with output_attentions=True), which
// this feature depends on entirely (segment boundaries for repetition
// comparison are derived from word timestamps, not just the transcript
// text) — the Xenova export includes cross-attentions and word timestamps
// work correctly.
const DEFAULT_MODEL = "Xenova/whisper-base";

export interface TranscriptionResult {
  language: string | null;
  words: WordTiming[];
  segments: TranscriptChunk[];
}

@Injectable()
export class WhisperService {
  private readonly logger = new Logger(WhisperService.name);
  private pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

  // Lazily loads (and caches in-process) the ASR pipeline on first use —
  // most of the app's requests never touch this, so paying the model
  // load cost at app startup for every deploy would be pure waste. The
  // model itself is cached to disk (see env.cacheDir below) so only the
  // very first scan on a fresh container pays the download cost.
  private getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
    if (!this.pipelinePromise) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR ?? join(process.cwd(), ".cache", "transformers");
      env.allowLocalModels = true;
      const model = process.env.WHISPER_MODEL ?? DEFAULT_MODEL;
      this.logger.log(`Loading Whisper model "${model}" (first use only, cached at ${env.cacheDir})`);
      this.pipelinePromise = pipeline("automatic-speech-recognition", model, { dtype: "q8" }).catch((err) => {
        this.pipelinePromise = null; // don't cache a failed load — the next scan should retry, not repeat the same failure forever
        throw err;
      });
    }
    return this.pipelinePromise;
  }

  // transformers.js's ASR pipeline never actually runs Whisper's own
  // language-detection step — confirmed by reading its source
  // (WhisperForConditionalGeneration._retrieve_init_tokens): with no
  // `language` passed, it just logs a warning and hardcodes English. For
  // non-English speech that means Whisper doesn't fail visibly — it
  // hallucinates a fluent, plausible-sounding *English* sentence instead
  // of the real words, so nothing about the output looks obviously wrong.
  // Confirmed live: this is exactly why the Hindi test case in the bug
  // report went undetected — the detector was comparing fabricated
  // English text, never the actual repeated Hindi phrase.
  //
  // Real language detection needs one raw decoder step per window
  // (Whisper's own trick: decode a single token from just the start-of-
  // transcript token, and see which language token the model predicts
  // with the highest logit) — the high-level pipeline doesn't expose
  // this, so it's done directly against the pipeline's own underlying
  // model/processor (reused, not reloaded). A single window isn't
  // reliable either — confirmed live: an early window scored English
  // marginally ahead (a title card/intro before the real narration), a
  // later window in the same file scored Hindi far ahead — so several
  // windows spread across the file are sampled and their scores summed.
  private async detectLanguage(samples: Float32Array): Promise<"english" | "hindi"> {
    const transcriber = await this.getPipeline();
    const { model, processor } = transcriber;
    const genConfig = model.generation_config as unknown as { decoder_start_token_id: number; lang_to_id: Record<string, number> };
    const startTokenTensor = new Tensor("int64", [BigInt(genConfig.decoder_start_token_id)], [1, 1]);

    const totalDurationMs = (samples.length / WHISPER_SAMPLE_RATE) * 1000;
    const windows = pickDetectionWindows(totalDurationMs);

    const logitSums: Record<string, number> = {};
    for (const window of windows) {
      const startSample = Math.floor((window.startMs / 1000) * WHISPER_SAMPLE_RATE);
      const endSample = Math.ceil((window.endMs / 1000) * WHISPER_SAMPLE_RATE);
      const slice = samples.subarray(startSample, Math.min(samples.length, endSample));
      if (slice.length === 0) continue;

      try {
        const inputs = await processor(slice);
        const output = await model({ input_features: inputs.input_features, decoder_input_ids: startTokenTensor });
        const vocabSize = output.logits.dims[2];
        const lastStepLogits = output.logits.data.slice(-vocabSize);
        for (const [token, id] of Object.entries(genConfig.lang_to_id)) {
          logitSums[token] = (logitSums[token] ?? 0) + Number(lastStepLogits[id]);
        }
      } catch (err) {
        this.logger.warn(`Language-detection window failed, skipping it: ${err instanceof Error ? err.message : err}`);
      }
    }

    return pickDominantLanguage(logitSums);
  }

  // `samples` must already be mono PCM at WHISPER_SAMPLE_RATE (see
  // pcm-extract.util.ts) — chunk_length_s/stride_length_s handle audio
  // longer than Whisper's native 30s window internally.
  async transcribe(samples: Float32Array): Promise<TranscriptionResult> {
    const transcriber = await this.getPipeline();
    const language = await this.detectLanguage(samples);

    const output = await transcriber(samples, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
      language,
    });
    const single = Array.isArray(output) ? output[0] : output;

    const chunks = (single.chunks ?? []) as { text: string; timestamp: [number, number] }[];
    const words: WordTiming[] = chunks
      .filter((c) => c.text.trim().length > 0)
      .map((c) => ({
        text: c.text,
        startMs: Math.round((c.timestamp[0] ?? 0) * 1000),
        endMs: Math.round((c.timestamp[1] ?? c.timestamp[0] ?? 0) * 1000),
      }));

    return {
      language,
      words,
      segments: groupWordsIntoSegments(words),
    };
  }
}

export { WHISPER_SAMPLE_RATE };

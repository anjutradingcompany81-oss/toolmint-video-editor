import { join } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { groupWordsIntoSegments, type TranscriptChunk, type WordTiming } from "./segment-transcript.util";

const WHISPER_SAMPLE_RATE = 16000;

// Runs entirely locally (no external API calls, nothing leaves the
// server), CPU-only — this VPS has no GPU, so a smaller multilingual
// model is used to keep scan times tolerable rather than reaching for a
// larger, more accurate one. Multilingual Whisper covers Hindi, English,
// and mixed Hindi-English speech (it auto-detects language per audio
// chunk rather than needing a fixed language setting, which matters
// specifically for code-switched dialogue).
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

  // `samples` must already be mono PCM at WHISPER_SAMPLE_RATE (see
  // pcm-extract.util.ts) — chunk_length_s/stride_length_s handle audio
  // longer than Whisper's native 30s window internally.
  async transcribe(samples: Float32Array): Promise<TranscriptionResult> {
    const transcriber = await this.getPipeline();
    const output = await transcriber(samples, {
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
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
      // transformers.js doesn't currently surface a detected-language
      // code through this pipeline's output — left null rather than
      // guessed; downstream code treats it as "unknown", not "English".
      language: null,
      words,
      segments: groupWordsIntoSegments(words),
    };
  }
}

export { WHISPER_SAMPLE_RATE };

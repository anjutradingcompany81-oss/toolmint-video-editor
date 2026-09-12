import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Writing a coherent narration script from a one-line prompt needs a real
// language model — there is no small local model on this CPU-only VPS
// that would produce writing worth speaking aloud, unlike the TTS voices
// themselves (see local-tts.provider.ts). This mirrors that file's own
// stance: a real HTTP integration, inert without ANTHROPIC_API_KEY, and
// says so rather than pretending — never silently returning a canned or
// low-quality script and reporting success.
//
// Plain fetch() rather than the @anthropic-ai/sdk package, matching
// elevenlabs-tts.provider.ts: one HTTP call each, not worth a dependency.
const API_ROOT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-5";
const REQUEST_TIMEOUT_MS = 60_000;
// Rough spoken pace used only to size the prompt sent to the model
// ("write about this many words") — the actual on-timeline pacing is
// computed afterwards from the words the model actually wrote (see
// script-line-layout.util.ts), not assumed here.
const WORDS_PER_MINUTE = 150;

export type ScriptGenReadiness = "READY" | "NEEDS_CONFIGURATION";

@Injectable()
export class AnthropicScriptProvider {
  readonly requiredEnvVar = "ANTHROPIC_API_KEY";
  private readonly logger = new Logger(AnthropicScriptProvider.name);

  constructor(private readonly config: ConfigService) {}

  private apiKey(): string | null {
    const key = this.config.get<string>("ANTHROPIC_API_KEY")?.trim();
    return key ? key : null;
  }

  readiness(): ScriptGenReadiness {
    return this.apiKey() ? "READY" : "NEEDS_CONFIGURATION";
  }

  // Returns the script as an ordered list of lines (sentences/short
  // phrases) meant to be spoken one after another — no timing information,
  // since a language model estimating its own speaking duration is not a
  // number worth trusting. The caller lays lines onto the timeline from
  // their actual word counts.
  async generateLines(prompt: string, targetDurationMs: number, language?: string): Promise<string[]> {
    const key = this.apiKey();
    if (!key) throw new Error("Script generation is not configured on this server (ANTHROPIC_API_KEY is not set)");

    const targetSeconds = Math.max(1, Math.round(targetDurationMs / 1000));
    const targetWords = Math.max(5, Math.round((targetSeconds / 60) * WORDS_PER_MINUTE));
    const languageInstruction = language ? ` Write it in ${language}.` : "";

    const system =
      `You write natural-sounding video voice-over narration. Given a topic and a target length, write a script paced to fill ` +
      `roughly that much spoken time, assuming a natural narration pace of about ${WORDS_PER_MINUTE} words per minute.` +
      `${languageInstruction} Return ONLY a JSON array of strings — no markdown fence, no numbering, no commentary outside the ` +
      `array. Each string is one sentence or short phrase meant to be spoken as a single continuous line.`;
    const user = `Topic/prompt: ${prompt}\nTarget length: about ${targetSeconds} seconds of narration (roughly ${targetWords} words total).`;

    let res: Response;
    try {
      res = await fetch(API_ROOT, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Couldn't reach Anthropic: ${err instanceof Error ? err.message : err}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text?.trim();
    if (!text) throw new Error("Anthropic returned an empty response");

    const lines = parseLinesArray(text);
    if (lines.length === 0) throw new Error("Couldn't parse a script from the model's response");
    return lines;
  }
}

// Models sometimes wrap otherwise-valid JSON in a markdown fence despite
// being told not to — strip that decoration rather than fail on it.
function parseLinesArray(text: string): string[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    }
  } catch {
    // Falls through to the empty-array return below, which the caller
    // turns into a clear "couldn't parse a script" error.
  }
  return [];
}

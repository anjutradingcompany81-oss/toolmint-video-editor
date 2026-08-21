// Pure helpers for the multi-window language-detection fix to the AI
// Repetitive Voice Remover's Whisper pipeline.
//
// transformers.js's high-level ASR pipeline never actually runs Whisper's
// own language-detection step — confirmed by reading its source
// (WhisperForConditionalGeneration._retrieve_init_tokens): when no
// `language` option is passed, it just logs "No language specified —
// defaulting to English" and hardcodes English, full stop. For anything
// non-English (this app's whole point is Hindi/English/mixed support),
// that means every scan silently transcribed Hindi speech as fabricated,
// fluent-sounding English text — Whisper hallucinates a plausible wrong-
// language sentence rather than failing visibly, so nothing about the
// output looks obviously broken. That's the actual root cause of "the app
// can't find repeated Hindi speech": it was never seeing real Hindi text
// to compare in the first place.
//
// A single detection window isn't reliable either — confirmed live: the
// first 10s of a real Hindi video scored English marginally higher
// (likely an English-styled intro/title card), while a window later in
// the same file scored Hindi far ahead (15.6 vs 10.8). Sampling several
// windows spread across the whole file and summing their language-token
// logits smooths this out.

export interface DetectionWindow {
  startMs: number;
  endMs: number;
}

// Spreads up to maxWindows windows of windowSeconds each evenly across
// the audio (skipping the very start/end, which are more likely to be
// silence, music stingers, or title cards not representative of the
// bulk of the spoken content). For audio shorter than one window, a
// single window covering everything is used.
export function pickDetectionWindows(totalDurationMs: number, windowSeconds = 10, maxWindows = 4): DetectionWindow[] {
  const windowMs = windowSeconds * 1000;
  if (totalDurationMs <= windowMs) {
    return [{ startMs: 0, endMs: totalDurationMs }];
  }

  const windowCount = Math.min(maxWindows, Math.max(1, Math.floor(totalDurationMs / windowMs)));
  const windows: DetectionWindow[] = [];
  for (let i = 0; i < windowCount; i++) {
    // Evenly spaced center points, inset from the very start/end by half
    // a window so no window runs past the audio's edges.
    const center = ((i + 1) / (windowCount + 1)) * totalDurationMs;
    const startMs = Math.max(0, Math.min(totalDurationMs - windowMs, center - windowMs / 2));
    windows.push({ startMs, endMs: startMs + windowMs });
  }
  return windows;
}

// Only the languages this product actually claims to support get to win
// outright — a model's own top guess among all ~100 tokens is noisy for
// short/ambiguous windows, but comparing specifically English vs. Hindi
// (folding the closely-related Urdu token into "Hindi", since Whisper's
// output script for Hindi speech sometimes lands on <|ur|> rather than
// <|hi|> despite correctly transcribing the actual Hindi words — confirmed
// live) is exactly the question this app needs answered. Any other
// language's score is ignored for the decision, though still contributes
// useful signal if this is later widened to more languages.
const HINDI_FAMILY_TOKENS = ["<|hi|>", "<|ur|>"];
const ENGLISH_TOKEN = "<|en|>";

export function pickDominantLanguage(logitSums: Record<string, number>): "english" | "hindi" {
  const englishScore = logitSums[ENGLISH_TOKEN] ?? -Infinity;
  const hindiScore = Math.max(...HINDI_FAMILY_TOKENS.map((t) => logitSums[t] ?? -Infinity));
  return hindiScore > englishScore ? "hindi" : "english";
}

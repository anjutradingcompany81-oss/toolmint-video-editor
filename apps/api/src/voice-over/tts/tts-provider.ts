// The contract every text-to-speech backend implements.
//
// Voice over is the one feature in this editor that can legitimately need
// a third-party service: cloning a specific person's voice is not
// something that can be done locally on a CPU-only VPS. Rather than
// either faking it or refusing to build the feature, every backend is
// modelled behind this interface and reports its own readiness, so the UI
// can tell the user the exact truth about each one:
//
//   READY               - implemented and usable right now
//   NEEDS_CONFIGURATION - implemented, but an API key/credential is missing
//
// A provider is never silently swapped for another. If the user picks one
// that isn't configured, generation is refused up front with the name of
// the missing setting - it does not quietly fall back to a different
// voice and report success, which would be exactly the kind of fake
// result this codebase must not produce.

export type TtsReadiness = "READY" | "NEEDS_CONFIGURATION";

export interface TtsVoice {
  id: string;
  label: string;
  // BCP-47-ish language tag this voice speaks, or "multi" for models that
  // take any language. Used to group the picker, and to warn when a line
  // is written in a script the selected voice can't pronounce.
  language: string;
  gender?: "male" | "female" | "neutral";
}

export interface TtsProviderStatus {
  id: string;
  label: string;
  description: string;
  readiness: TtsReadiness;
  // Names the exact environment variable an operator has to set. Shown
  // verbatim in the UI so "not configured" is actionable instead of a
  // dead end.
  requiredEnvVar: string | null;
  supportsVoiceCloning: boolean;
  // Populated only when readiness is READY - listing voices generally
  // means an authenticated call, which is pointless without credentials.
  voices: TtsVoice[];
}

export interface SynthesisRequest {
  text: string;
  voiceId: string;
}

export interface SynthesisResult {
  // Mono PCM at `sampleRate`, in -1..1. Deliberately raw rather than an
  // encoded file: the mixer has to delay and overlay these onto one
  // track, and every provider returning the same uncompressed shape means
  // the mix step doesn't need a per-provider decode path.
  samples: Float32Array;
  sampleRate: number;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly requiredEnvVar: string | null;
  readonly supportsVoiceCloning: boolean;

  /** Whether the credentials/models this provider needs are present. */
  readiness(): TtsReadiness;

  /** Voices this provider can speak with. Only called when READY. */
  listVoices(): Promise<TtsVoice[]>;

  /**
   * Speak one line. Implementations must reject rather than return
   * silence when they cannot produce audio - a silent buffer would look
   * like success all the way through to the exported file.
   */
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

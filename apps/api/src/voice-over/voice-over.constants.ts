export const VOICE_OVER_QUEUE_NAME = "voice-over";
export const VOICE_OVER_REDIS_CONNECTION = Symbol("VOICE_OVER_REDIS_CONNECTION");
export const VOICE_OVER_QUEUE = Symbol("VOICE_OVER_QUEUE");

// Everything is resampled to this before mixing. 24kHz is the highest
// rate any current provider emits, so choosing it means the cloud voices
// are never downsampled - only the 16kHz local models are interpolated
// up, which cannot lose detail that was there to begin with.
export const VOICE_OVER_SAMPLE_RATE = 24000;

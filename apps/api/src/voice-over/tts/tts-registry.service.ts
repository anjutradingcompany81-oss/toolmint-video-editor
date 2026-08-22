import { Injectable } from "@nestjs/common";
import { ElevenLabsTtsProvider } from "./elevenlabs-tts.provider";
import { LocalTtsProvider } from "./local-tts.provider";
import type { TtsProvider, TtsProviderStatus } from "./tts-provider";

// Single place that knows which speech backends exist and which of them
// this particular server can actually use right now.
//
// The point of routing everything through here is that the UI never has
// to guess. It asks for the list, gets each provider's real readiness,
// and can therefore say "ready", or "needs ELEVENLABS_API_KEY", instead
// of offering a control that fails only once the user commits to it.
@Injectable()
export class TtsRegistryService {
  private readonly providers: TtsProvider[];

  constructor(local: LocalTtsProvider, elevenLabs: ElevenLabsTtsProvider) {
    // Local first: it is the one that always works, so it is the sane
    // default selection in the picker.
    this.providers = [local, elevenLabs];
  }

  get(providerId: string): TtsProvider | null {
    return this.providers.find((p) => p.id === providerId) ?? null;
  }

  defaultProviderId(): string {
    return (this.providers.find((p) => p.readiness() === "READY") ?? this.providers[0]!).id;
  }

  async statuses(): Promise<TtsProviderStatus[]> {
    return Promise.all(
      this.providers.map(async (provider) => {
        const readiness = provider.readiness();
        return {
          id: provider.id,
          label: provider.label,
          description: provider.description,
          readiness,
          requiredEnvVar: provider.requiredEnvVar,
          supportsVoiceCloning: provider.supportsVoiceCloning,
          // Listing voices on an unconfigured provider would be a
          // guaranteed-failing authenticated call.
          voices: readiness === "READY" ? await provider.listVoices() : [],
        };
      }),
    );
  }
}

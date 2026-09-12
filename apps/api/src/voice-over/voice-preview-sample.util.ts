// A short, fixed phrase to speak when a user wants to hear what a voice
// sounds like before writing any real content — auditioning a voice
// shouldn't require typing a whole script first. One phrase per language
// this project's providers actually offer — the built-in MMS voices in
// local-tts.provider.ts, plus Hindi from the Indic sidecar — so a Hindi
// voice is heard saying something in Hindi, not English text
// mispronounced. Keyed by language rather than by voice, so it keeps
// working when a language moves between providers.
const SAMPLE_TEXT_BY_LANGUAGE: Record<string, string> = {
  en: "This is a sample of this voice.",
  hi: "यह इस आवाज़ का एक नमूना है।",
  es: "Esta es una muestra de esta voz.",
  fr: "Ceci est un exemple de cette voix.",
  de: "Dies ist eine Hörprobe dieser Stimme.",
  ar: "هذه عينة من هذا الصوت.",
};

const DEFAULT_SAMPLE_TEXT = SAMPLE_TEXT_BY_LANGUAGE.en;

export function samplePhraseForLanguage(language: string): string {
  return SAMPLE_TEXT_BY_LANGUAGE[language] ?? DEFAULT_SAMPLE_TEXT;
}

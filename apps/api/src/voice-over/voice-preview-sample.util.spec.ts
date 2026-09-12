import { samplePhraseForLanguage } from "./voice-preview-sample.util";

describe("samplePhraseForLanguage", () => {
  it("returns the Hindi sample in Devanagari for hi", () => {
    expect(samplePhraseForLanguage("hi")).toBe("यह इस आवाज़ का एक नमूना है।");
  });

  it("returns the English sample for en", () => {
    expect(samplePhraseForLanguage("en")).toBe("This is a sample of this voice.");
  });

  it("falls back to English for a language with no sample phrase", () => {
    expect(samplePhraseForLanguage("ja")).toBe(samplePhraseForLanguage("en"));
  });

  it("falls back to English for an ElevenLabs 'multi' voice", () => {
    expect(samplePhraseForLanguage("multi")).toBe(samplePhraseForLanguage("en"));
  });
});

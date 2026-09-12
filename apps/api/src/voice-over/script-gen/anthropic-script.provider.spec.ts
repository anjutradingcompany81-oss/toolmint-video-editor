import { ConfigService } from "@nestjs/config";
import { AnthropicScriptProvider } from "./anthropic-script.provider";

function makeProvider(apiKey: string | undefined): AnthropicScriptProvider {
  const config = { get: (key: string) => (key === "ANTHROPIC_API_KEY" ? apiKey : undefined) } as unknown as ConfigService;
  return new AnthropicScriptProvider(config);
}

function mockFetchOnce(response: Partial<Response> & { text?: () => Promise<string> }) {
  global.fetch = jest.fn().mockResolvedValue(response as Response);
}

describe("AnthropicScriptProvider", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("readiness", () => {
    it("is NEEDS_CONFIGURATION with no API key", () => {
      expect(makeProvider(undefined).readiness()).toBe("NEEDS_CONFIGURATION");
    });

    it("is NEEDS_CONFIGURATION for a blank/whitespace-only key", () => {
      expect(makeProvider("   ").readiness()).toBe("NEEDS_CONFIGURATION");
    });

    it("is READY once a key is set", () => {
      expect(makeProvider("sk-ant-test").readiness()).toBe("READY");
    });
  });

  describe("generateLines", () => {
    it("refuses up front when not configured, without making a request", async () => {
      const provider = makeProvider(undefined);
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy;
      await expect(provider.generateLines("a lion and an ant", 10_000)).rejects.toThrow(/ANTHROPIC_API_KEY/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("parses a plain JSON array response", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: '["Once upon a time.", "The end."]' }] }),
      });
      const lines = await makeProvider("sk-ant-test").generateLines("a story", 5000);
      expect(lines).toEqual(["Once upon a time.", "The end."]);
    });

    it("strips a markdown fence the model added despite being told not to", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: '```json\n["Line one.", "Line two."]\n```' }] }),
      });
      const lines = await makeProvider("sk-ant-test").generateLines("a story", 5000);
      expect(lines).toEqual(["Line one.", "Line two."]);
    });

    it("drops non-string entries and trims whitespace", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: '["  padded  ", 42, "", "  ", "kept"]' }] }),
      });
      const lines = await makeProvider("sk-ant-test").generateLines("a story", 5000);
      expect(lines).toEqual(["padded", "kept"]);
    });

    it("throws a clear error when the response isn't valid JSON at all", async () => {
      mockFetchOnce({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "Sure! Here is a script for you:\nOnce upon a time." }] }),
      });
      await expect(makeProvider("sk-ant-test").generateLines("a story", 5000)).rejects.toThrow(/couldn't parse/i);
    });

    it("throws with the response body when Anthropic returns a non-2xx status", async () => {
      mockFetchOnce({ ok: false, status: 401, text: async () => '{"error":"invalid api key"}' });
      await expect(makeProvider("sk-ant-test").generateLines("a story", 5000)).rejects.toThrow(/401/);
    });

    it("throws a clear error when the network call itself fails", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
      await expect(makeProvider("sk-ant-test").generateLines("a story", 5000)).rejects.toThrow(/couldn't reach anthropic/i);
    });
  });
});

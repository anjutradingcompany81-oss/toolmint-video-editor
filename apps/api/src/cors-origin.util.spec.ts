import { buildAllowedOrigins, isAllowedOrigin } from "./cors-origin.util";

describe("buildAllowedOrigins", () => {
  it("adds the www variant when the configured URL has none", () => {
    expect(buildAllowedOrigins("https://toolmint.co.in")).toEqual(
      expect.arrayContaining(["https://toolmint.co.in", "https://www.toolmint.co.in"]),
    );
  });

  it("adds the bare-domain variant when the configured URL already has www", () => {
    expect(buildAllowedOrigins("https://www.toolmint.co.in")).toEqual(
      expect.arrayContaining(["https://www.toolmint.co.in", "https://toolmint.co.in"]),
    );
  });

  it("returns exactly two entries — no duplicates, no extras", () => {
    expect(buildAllowedOrigins("https://www.toolmint.co.in")).toHaveLength(2);
  });

  it("preserves a non-standard port on both variants", () => {
    expect(buildAllowedOrigins("http://localhost:3010")).toEqual(
      expect.arrayContaining(["http://localhost:3010", "http://www.localhost:3010"]),
    );
  });

  it("falls back to just the configured value for an unparseable URL, rather than throwing", () => {
    expect(buildAllowedOrigins("not-a-url")).toEqual(["not-a-url"]);
  });
});

describe("isAllowedOrigin", () => {
  const allowed = buildAllowedOrigins("https://www.toolmint.co.in");

  it("allows the exact configured origin", () => {
    expect(isAllowedOrigin("https://www.toolmint.co.in", allowed)).toBe(true);
  });

  it("allows the bare-domain variant too", () => {
    expect(isAllowedOrigin("https://toolmint.co.in", allowed)).toBe(true);
  });

  it("allows a request with no Origin header (same-origin or non-browser)", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it("rejects an unrelated origin", () => {
    expect(isAllowedOrigin("https://evil.example.com", allowed)).toBe(false);
  });

  it("rejects a subtly different scheme or port on an otherwise-matching host", () => {
    expect(isAllowedOrigin("http://toolmint.co.in", allowed)).toBe(false);
    expect(isAllowedOrigin("https://toolmint.co.in:8443", allowed)).toBe(false);
  });
});

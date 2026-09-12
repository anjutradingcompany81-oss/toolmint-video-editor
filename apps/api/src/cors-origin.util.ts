// The bare-domain vs. "www." variant of the same site is an easy mistake
// to land on by accident — a typed URL, an old bookmark, a search result
// — and a CORS policy that only allows the exact configured origin turns
// that into every single API call failing with no visible reason on the
// page itself (confirmed live: toolmint.co.in vs. www.toolmint.co.in,
// where only the "www" form was ever allowed and the other one silently
// broke everything that doesn't have a client-side fallback). Deriving
// both variants from whatever's actually configured — rather than
// hardcoding a domain name — means this fix isn't specific to one site.
export function buildAllowedOrigins(configuredUrl: string): string[] {
  const allowed = new Set([configuredUrl]);
  try {
    const url = new URL(configuredUrl);
    const altHost = url.hostname.startsWith("www.") ? url.hostname.slice(4) : `www.${url.hostname}`;
    if (altHost) {
      const port = url.port ? `:${url.port}` : "";
      allowed.add(`${url.protocol}//${altHost}${port}`);
    }
  } catch {
    // configuredUrl isn't a valid absolute URL — fall through with just
    // the one entry rather than throwing during server startup.
  }
  return [...allowed];
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  // No Origin header at all means a same-origin or non-browser request
  // (curl, a server-to-server call) — CORS only governs cross-origin
  // browser requests, so there's nothing to check here.
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

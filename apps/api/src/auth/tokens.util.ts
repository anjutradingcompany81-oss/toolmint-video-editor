import { createHash, randomBytes } from "crypto";

// Opaque bearer tokens (refresh / email-verify / password-reset): only the
// hash is ever persisted, so a database read alone can't be replayed as a
// credential.
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration "${value}" — expected a format like "15m", "1h", or "30d"`);
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2]];
}

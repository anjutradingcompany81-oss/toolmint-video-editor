import type { Prisma } from "@prisma/client";

// A project always has at least this empty shell as its initial
// ProjectVersion, filled in by the editor once clips exist.
export function buildEmptyComposition(): Prisma.InputJsonValue {
  return {
    schemaVersion: "1.0",
    clips: [],
    updatedAt: new Date().toISOString(),
  };
}

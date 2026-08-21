import type { Prisma } from "@prisma/client";

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// A project always has at least this empty shell as its initial
// ProjectVersion. One default video track exists from the start so the
// editor always has somewhere to drop the first clip without the user
// having to create a track first.
export function buildEmptyComposition(): Prisma.InputJsonValue {
  return {
    schemaVersion: "2.0",
    tracks: [{ id: randomId("track"), kind: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, solo: false }],
    clips: [],
    updatedAt: new Date().toISOString(),
  };
}

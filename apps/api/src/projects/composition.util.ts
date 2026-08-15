import type { Prisma, ProjectAspectRatio } from "@prisma/client";

// Matches the "Timeline composition JSON specification" — a project always
// has at least this empty shell as its initial ProjectVersion, filled in by
// the editor once it exists.
export function buildEmptyComposition(project: { aspectRatio: ProjectAspectRatio; fps: number }): Prisma.InputJsonValue {
  return {
    schemaVersion: "1.0",
    aspectRatio: project.aspectRatio,
    fps: project.fps,
    scenes: [],
    updatedAt: new Date().toISOString(),
  };
}

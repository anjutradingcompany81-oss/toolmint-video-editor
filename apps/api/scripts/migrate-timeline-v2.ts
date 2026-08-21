// One-time data migration: rewrites every ProjectVersion.composition from
// the v1 shape (flat, position-less Clip[] — array order was the timeline
// order) into the v2 shape (Track[] + Clip[] with absolute startMs).
//
// Every existing clip becomes a "video" clip on one new default track
// ("Video 1"), positioned back-to-back in the same order they already
// played in — the migration is purely a *representation* change, the
// resulting timeline plays back identically to before.
//
// Every historical ProjectVersion row is migrated, not just the latest
// one per project — nothing today reads an old version (only the latest
// is ever loaded), but leaving stale-shape rows behind would make the
// table internally inconsistent for no benefit.
//
// Usage:
//   npx ts-node scripts/migrate-timeline-v2.ts            # dry run — logs what would change, writes nothing
//   npx ts-node scripts/migrate-timeline-v2.ts --apply     # actually writes the new composition to every v1 row

import { PrismaClient } from "@prisma/client";

const MIN_CLIP_DURATION_MS = 200;

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

interface V1Clip {
  id: string;
  mediaAssetId: string;
  trimInMs?: number;
  trimOutMs?: number;
  volume?: number;
  muted?: boolean;
}

interface V1Composition {
  schemaVersion: "1.0";
  clips: V1Clip[];
  updatedAt?: string;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const prisma = new PrismaClient();

  const versions = await prisma.projectVersion.findMany({
    select: { id: true, projectId: true, composition: true },
  });

  const v1Versions = versions.filter((v) => {
    const c = v.composition as unknown as { schemaVersion?: string } | null;
    return c?.schemaVersion === "1.0";
  });

  console.log(`${versions.length} ProjectVersion rows total, ${v1Versions.length} at schemaVersion 1.0 to migrate.`);
  if (v1Versions.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  // Every mediaAssetId referenced anywhere, fetched once instead of once
  // per clip — these rows can genuinely repeat across versions/projects.
  const allMediaAssetIds = new Set<string>();
  for (const v of v1Versions) {
    const composition = v.composition as unknown as V1Composition;
    for (const clip of composition.clips ?? []) allMediaAssetIds.add(clip.mediaAssetId);
  }
  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: Array.from(allMediaAssetIds) } },
    select: { id: true, durationMs: true },
  });
  const durationById = new Map(assets.map((a) => [a.id, a.durationMs]));

  let migrated = 0;
  let missingAssetWarnings = 0;

  for (const v of v1Versions) {
    const composition = v.composition as unknown as V1Composition;
    const trackId = randomId("track");
    const track = { id: trackId, kind: "video", name: "Video 1", order: 0, locked: false, hidden: false, muted: false, solo: false };

    let cursor = 0;
    const clips = (composition.clips ?? []).map((clip) => {
      const sourceDurationMs = durationById.get(clip.mediaAssetId);
      if (sourceDurationMs == null) {
        missingAssetWarnings++;
        console.warn(`  [${v.projectId}/${v.id}] clip ${clip.id} references missing/unprobed media ${clip.mediaAssetId} — using minimum duration`);
      }
      const trimInMs = clip.trimInMs ?? 0;
      const trimOutMs = clip.trimOutMs ?? 0;
      const durationMs = Math.max(MIN_CLIP_DURATION_MS, (sourceDurationMs ?? MIN_CLIP_DURATION_MS) - trimInMs - trimOutMs);
      const startMs = cursor;
      cursor += durationMs;

      return {
        id: clip.id, // preserve identity — this clip isn't being split or altered, just repositioned
        trackId,
        kind: "video" as const,
        startMs,
        durationMs,
        mediaAssetId: clip.mediaAssetId,
        trimInMs,
        trimOutMs,
        volume: clip.volume ?? 1,
        muted: clip.muted ?? false,
        speedPercent: 100,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
    });

    const newComposition = {
      schemaVersion: "2.0",
      tracks: [track],
      clips,
      updatedAt: composition.updatedAt ?? new Date().toISOString(),
    };

    console.log(`  [${v.projectId}/${v.id}] ${composition.clips?.length ?? 0} clip(s) -> 1 track, total ${cursor}ms`);

    if (apply) {
      await prisma.projectVersion.update({ where: { id: v.id }, data: { composition: newComposition } });
    }
    migrated++;
  }

  console.log(
    `\n${apply ? "Migrated" : "Would migrate"} ${migrated} version(s).` +
      (missingAssetWarnings > 0 ? ` ${missingAssetWarnings} clip(s) referenced missing/unprobed media — check the warnings above.` : ""),
  );
  if (!apply) console.log("Dry run only — re-run with --apply to write these changes.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

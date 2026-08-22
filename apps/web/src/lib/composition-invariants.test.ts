// Every timeline mutation must leave the composition in a state the
// backend will actually accept. The server rejects (400) any same-track
// clip overlap, and any audio patch that runs past its clip's end or
// overlaps another patch on the same clip — see
// apps/api/src/projects/composition.schema.ts's superRefine.
//
// Until now nothing checked that client-side, so a mutation that produced
// an invalid layout only surfaced as a silent "Couldn't save" in the
// header, with the user's edits accumulating and every subsequent autosave
// failing too. These tests assert the invariant after realistic sequences
// of operations rather than after single calls in isolation.
import { describe, expect, it } from "vitest";
import {
  addAudioPatch,
  duplicateClip,
  moveClip,
  removeRangeOnTrack,
  resolveSourceRange,
  rippleDeleteClip,
  splitClip,
  trimClipOnTrack,
  type Clip,
  type MediaClip,
} from "./composition-api";

const TRACK = "track_1";
const SOURCE_MS = 249_507; // the real asset length from the failing project

function baseClip(overrides: Partial<MediaClip> = {}): MediaClip {
  return {
    id: "clip_main",
    trackId: TRACK,
    kind: "video",
    mediaAssetId: "asset",
    startMs: 0,
    durationMs: SOURCE_MS,
    trimInMs: 0,
    trimOutMs: 0,
    volume: 1,
    muted: false,
    speedPercent: 100,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    audioPatches: [],
    ...overrides,
  };
}

/** Mirrors the server's superRefine. Returns the reasons it would 400. */
function serverRejections(clips: Clip[]): string[] {
  const problems: string[] = [];

  const onTrack = clips.filter((c) => c.trackId === TRACK).slice().sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < onTrack.length; i++) {
    if (onTrack[i].startMs < onTrack[i - 1].startMs + onTrack[i - 1].durationMs) {
      problems.push(`clip ${onTrack[i].id} overlaps another clip on the same track`);
    }
  }

  for (const clip of clips) {
    if (clip.kind === "text") continue;
    if (clip.durationMs <= 0) problems.push(`clip ${clip.id} has a non-positive durationMs`);
    if (clip.startMs < 0) problems.push(`clip ${clip.id} has a negative startMs`);
    const patches = [...clip.audioPatches].sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < patches.length; i++) {
      if (patches[i].startMs < 0) problems.push(`patch on ${clip.id} starts before the clip`);
      if (patches[i].endMs > clip.durationMs) problems.push(`patch on ${clip.id} extends past the end of its clip`);
      if (patches[i].endMs <= patches[i].startMs) problems.push(`patch on ${clip.id} has endMs <= startMs`);
      if (i > 0 && patches[i].startMs < patches[i - 1].endMs) problems.push(`patches on ${clip.id} overlap`);
    }
  }
  return problems;
}

const sourceDurationOf = () => SOURCE_MS;

describe("composition stays server-valid through realistic edit sequences", () => {
  it("split, then trim each half, then move one — the sequence from the failing project", () => {
    let clips: Clip[] = [baseClip()];

    const [a, b] = splitClip(clips[0] as MediaClip, SOURCE_MS, 120_000)!;
    clips = [a, b];
    expect(serverRejections(clips)).toEqual([]);

    clips = trimClipOnTrack(clips, a.id, SOURCE_MS, 0, SOURCE_MS - 60_000);
    expect(serverRejections(clips)).toEqual([]);

    clips = trimClipOnTrack(clips, b.id, SOURCE_MS, 150_000, 0);
    expect(serverRejections(clips)).toEqual([]);

    clips = moveClip(clips, b.id, 5_000);
    expect(serverRejections(clips)).toEqual([]);
  });

  it("un-trimming a clip back to full length never overruns its neighbour", () => {
    // Two adjacent clips with no gap, the first heavily trimmed. Dragging
    // its end handle right asks for far more length than the gap allows.
    let clips: Clip[] = [
      baseClip({ id: "a", startMs: 0, durationMs: 10_000, trimOutMs: SOURCE_MS - 10_000 }),
      baseClip({ id: "b", startMs: 10_000, durationMs: 20_000, trimInMs: 100_000, trimOutMs: SOURCE_MS - 120_000 }),
    ];
    clips = trimClipOnTrack(clips, "a", SOURCE_MS, 0, 0);
    expect(serverRejections(clips)).toEqual([]);
  });

  it("a clip squeezed into a slot smaller than the minimum duration still never overlaps", () => {
    // The pathological case: only 50ms of room, which is below
    // MIN_CLIP_DURATION_MS, so clamping to the minimum would overlap.
    let clips: Clip[] = [
      baseClip({ id: "a", startMs: 0, durationMs: 5_000, trimOutMs: SOURCE_MS - 5_000 }),
      baseClip({ id: "b", startMs: 5_050, durationMs: 10_000, trimInMs: 50_000, trimOutMs: SOURCE_MS - 60_000 }),
    ];
    clips = trimClipOnTrack(clips, "a", SOURCE_MS, 0, 0);
    expect(serverRejections(clips)).toEqual([]);
  });

  it("duplicate then ripple-delete keeps every clip disjoint", () => {
    let clips: Clip[] = [baseClip({ id: "a", startMs: 0, durationMs: 30_000, trimOutMs: SOURCE_MS - 30_000 })];
    clips = duplicateClip(clips, "a");
    expect(serverRejections(clips)).toEqual([]);
    const copyId = clips.find((c) => c.id !== "a")!.id;
    clips = duplicateClip(clips, copyId);
    expect(serverRejections(clips)).toEqual([]);
    clips = rippleDeleteClip(clips, copyId);
    expect(serverRejections(clips)).toEqual([]);
  });

  it("refuses an AI correction whose coordinates are stale, instead of writing an unsaveable patch", () => {
    // Reproduces the reported failure: the scan ran against the full 249s
    // clip, the user then trimmed it to 30s, and applying a result from
    // 4:03 wrote a patch past the clip's end. The server rejected the whole
    // composition, and since the bad patch stayed in local state every
    // later autosave failed too — surfacing only as a stuck "Couldn't
    // save". It must now refuse with an explanation and change nothing.
    const clips: Clip[] = [baseClip({ id: "a", startMs: 0, durationMs: 30_000, trimOutMs: SOURCE_MS - 30_000 })];
    const result = addAudioPatch(clips, "a", { startMs: 243_000, endMs: 244_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no longer exists|new scan/i);
    expect(serverRejections(clips)).toEqual([]); // original state untouched
  });

  it("refuses a second correction overlapping one already applied", () => {
    const clips: Clip[] = [baseClip({ id: "a", startMs: 0, durationMs: 60_000, trimOutMs: SOURCE_MS - 60_000 })];
    const once = addAudioPatch(clips, "a", { startMs: 20_000, endMs: 22_000 });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(serverRejections(once.clips)).toEqual([]);

    const twice = addAudioPatch(once.clips, "a", { startMs: 21_000, endMs: 23_000 });
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.message).toMatch(/already been corrected/i);
  });

  it("accepts a correction that is still in range, and the result stays server-valid", () => {
    const clips: Clip[] = [baseClip({ id: "a", startMs: 0, durationMs: 60_000, trimOutMs: SOURCE_MS - 60_000 })];
    const result = addAudioPatch(clips, "a", { startMs: 21_740, endMs: 22_400 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(serverRejections(result.clips)).toEqual([]);
    expect((result.clips[0] as MediaClip).audioPatches).toHaveLength(1);
  });

  it("clamps a correction that only slightly overruns the clip end rather than rejecting it", () => {
    // A result ending a few ms past the clip boundary is a rounding
    // artifact, not a stale coordinate — trimming it to the clip end keeps
    // the correction usable instead of failing on a technicality.
    const clips: Clip[] = [baseClip({ id: "a", startMs: 0, durationMs: 30_000, trimOutMs: SOURCE_MS - 30_000 })];
    const result = addAudioPatch(clips, "a", { startMs: 29_500, endMs: 30_400 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.clips[0] as MediaClip).audioPatches[0].endMs).toBe(30_000);
    expect(serverRejections(result.clips)).toEqual([]);
  });

  it("locates a correction by source offset after the clip was split into new ids", () => {
    // Reproduces the reported "That clip no longer exists on the timeline":
    // splitting mints brand-new clip ids, so a result recorded against the
    // original id is orphaned. Source offsets survive it.
    const original = baseClip({ id: "clip_main" });
    const [a, b] = splitClip(original, SOURCE_MS, 120_000)!;
    const clips: Clip[] = [a, b];
    expect(clips.map((c) => c.id)).not.toContain("clip_main"); // ids really did change

    // A repetition found at 2:26 of the source file (146,480ms).
    const target = resolveSourceRange(clips, "asset", 146_480, 148_000);
    expect(target).not.toBeNull();
    expect(target!.clip.id).toBe(b.id); // lives in the second half now
    expect(target!.localStartMs).toBe(146_480 - b.trimInMs);
    expect(target!.timelineStartMs).toBe(b.startMs + (146_480 - b.trimInMs));
  });

  it("still locates a correction after the clip is moved and the earlier part cut away", () => {
    let clips: Clip[] = [baseClip({ id: "clip_main" })];
    const cut = removeRangeOnTrack(clips, TRACK, sourceDurationOf, 0, 60_000);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    clips = cut.clips;
    clips = moveClip(clips, clips[0].id, 30_000);

    // Source 2:26 is still present (only 0-60s of source was removed).
    const target = resolveSourceRange(clips, "asset", 146_480, 148_000);
    expect(target).not.toBeNull();
    const patchResult = addAudioPatch(clips, target!.clip.id, { startMs: target!.localStartMs, endMs: target!.localEndMs });
    expect(patchResult.ok).toBe(true);
    if (!patchResult.ok) return;
    expect(serverRejections(patchResult.clips)).toEqual([]);
  });

  it("returns null when the correction's audio really was cut out", () => {
    let clips: Clip[] = [baseClip({ id: "clip_main" })];
    // Remove the stretch of source containing 2:26.
    const cut = removeRangeOnTrack(clips, TRACK, sourceDurationOf, 140_000, 160_000);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    clips = cut.clips;
    expect(resolveSourceRange(clips, "asset", 146_480, 148_000)).toBeNull();
  });

  it("picks the half holding most of the range when a split straddles it", () => {
    const [a, b] = splitClip(baseClip({ id: "clip_main" }), SOURCE_MS, 100_000)!;
    const clips: Clip[] = [a, b];
    // Range 99,000-101,000 straddles the split at source 100,000; 1,000ms
    // falls in each half, so either is acceptable, but it must resolve and
    // stay inside whichever clip it picks.
    const target = resolveSourceRange(clips, "asset", 99_000, 101_000);
    expect(target).not.toBeNull();
    expect(target!.localStartMs).toBeGreaterThanOrEqual(0);
    expect(target!.localEndMs).toBeLessThanOrEqual(target!.clip.durationMs);
  });

  it("ignores clips built from a different source file", () => {
    const clips: Clip[] = [baseClip({ id: "other", mediaAssetId: "different-asset" })];
    expect(resolveSourceRange(clips, "asset", 146_480, 148_000)).toBeNull();
  });

  it("cutting a marked range leaves a valid, gapless track", () => {
    let clips: Clip[] = [baseClip()];
    const result = removeRangeOnTrack(clips, TRACK, sourceDurationOf, 60_000, 90_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    clips = result.clips;
    expect(serverRejections(clips)).toEqual([]);
  });
});

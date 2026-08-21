import { describe, expect, it } from "vitest";
import {
  addAudioPatch,
  clipDurationFromTrim,
  MIN_CLIP_DURATION_MS,
  newVideoClip,
  removeAudioPatch,
  removeRangeOnTrack,
  repackTrack,
  splitClip,
  type MediaClip,
} from "./composition-api";

const TRACK_A = "track_a";
const TRACK_B = "track_b";

function buildClip(overrides: Partial<MediaClip> = {}): MediaClip {
  return {
    id: overrides.id ?? "clip",
    trackId: TRACK_A,
    kind: "video",
    mediaAssetId: "asset",
    startMs: 0,
    durationMs: 10_000,
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

// A single 10s source clip, untrimmed, so timeline duration == source duration.
const SOURCE_MS = 10_000;
const sourceDurationOf = () => SOURCE_MS;

describe("newVideoClip", () => {
  it("starts untrimmed, full volume, unmuted, at the given position", () => {
    const clip = newVideoClip(TRACK_A, "asset_1", 5000, SOURCE_MS);
    expect(clip.trackId).toBe(TRACK_A);
    expect(clip.mediaAssetId).toBe("asset_1");
    expect(clip.startMs).toBe(5000);
    expect(clip.durationMs).toBe(SOURCE_MS);
    expect(clip.trimInMs).toBe(0);
    expect(clip.trimOutMs).toBe(0);
    expect(clip.volume).toBe(1);
    expect(clip.muted).toBe(false);
    expect(clip.speedPercent).toBe(100);
  });

  it("gives every new clip a unique id", () => {
    const a = newVideoClip(TRACK_A, "asset_1", 0, SOURCE_MS);
    const b = newVideoClip(TRACK_A, "asset_1", 0, SOURCE_MS);
    expect(a.id).not.toBe(b.id);
  });
});

describe("clipDurationFromTrim", () => {
  it("subtracts both trims from the source duration", () => {
    expect(clipDurationFromTrim(10_000, 1000, 2000)).toBe(7000);
  });

  it("clamps to the minimum instead of going to zero or negative", () => {
    expect(clipDurationFromTrim(10_000, 4900, 4900)).toBe(MIN_CLIP_DURATION_MS);
  });
});

describe("repackTrack", () => {
  it("positions clips back-to-back in ascending order of their current startMs", () => {
    const clips = [
      buildClip({ id: "b", startMs: 9000, durationMs: 1000 }),
      buildClip({ id: "a", startMs: 0, durationMs: 2000 }),
    ];
    const result = repackTrack(clips, TRACK_A);
    const byId = new Map(result.map((c) => [c.id, c]));
    expect(byId.get("a")!.startMs).toBe(0);
    expect(byId.get("b")!.startMs).toBe(2000); // right after "a", no gap despite the original 9000 gap
  });

  it("leaves clips on other tracks untouched", () => {
    const other = buildClip({ id: "other", trackId: TRACK_B, startMs: 500, durationMs: 1000 });
    const result = repackTrack([buildClip({ id: "a" }), other], TRACK_A);
    expect(result.find((c) => c.id === "other")).toEqual(other);
  });
});

describe("splitClip", () => {
  it("splits into two complementary halves at the given offset, second half repositioned after the first", () => {
    const clip = buildClip({ startMs: 1000, durationMs: 10_000 });
    const result = splitClip(clip, SOURCE_MS, 4000);
    expect(result).not.toBeNull();
    const [first, second] = result!;
    expect(first.startMs).toBe(1000);
    expect(first.durationMs).toBe(4000);
    expect(first.trimOutMs).toBe(6000);
    expect(second.startMs).toBe(5000);
    expect(second.durationMs).toBe(6000);
    expect(second.trimInMs).toBe(4000);
  });

  it("gives the two halves different ids", () => {
    const clip = buildClip();
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe(clip.id);
  });

  it("refuses a split too close to either end", () => {
    const clip = buildClip();
    expect(splitClip(clip, SOURCE_MS, 50)).toBeNull();
    expect(splitClip(clip, SOURCE_MS, SOURCE_MS - 50)).toBeNull();
  });
});

describe("removeRangeOnTrack", () => {
  it("rejects an end at or before the start", () => {
    const clips = [buildClip()];
    expect(removeRangeOnTrack(clips, TRACK_A, sourceDurationOf, 5000, 5000).ok).toBe(false);
    expect(removeRangeOnTrack(clips, TRACK_A, sourceDurationOf, 6000, 4000).ok).toBe(false);
  });

  it("rejects a negative start", () => {
    const result = removeRangeOnTrack([buildClip()], TRACK_A, sourceDurationOf, -100, 1000);
    expect(result.ok).toBe(false);
  });

  it("rejects a range that overlaps nothing on the timeline", () => {
    const result = removeRangeOnTrack([buildClip()], TRACK_A, sourceDurationOf, 12_000, 15_000);
    expect(result.ok).toBe(false);
  });

  it("cuts an unwanted middle section out of a single clip, joining the remainder with no gap", () => {
    // One 10s clip, remove the middle 2s-6s (4s), leaving 6s total.
    const result = removeRangeOnTrack([buildClip()], TRACK_A, sourceDurationOf, 2000, 6000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips).toHaveLength(2);
    const totalMs = result.clips.reduce((sum, c) => sum + c.durationMs, 0);
    expect(totalMs).toBe(6000); // 10s - 4s cut = 6s, no leftover gap

    const [first, second] = result.clips as MediaClip[];
    expect(first.startMs).toBe(0);
    expect(first.durationMs).toBe(2000);
    expect(second.startMs).toBe(2000); // repacked immediately after the first, no gap
    expect(second.durationMs).toBe(4000);
  });

  it("trims the tail off a clip when the cut starts inside it and ends at/after its end", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 10_000 }), buildClip({ id: "b", startMs: 10_000, durationMs: 10_000 })];
    // Cut 8000-14000 removes a's tail and b's head.
    const result = removeRangeOnTrack(clips, TRACK_A, sourceDurationOf, 8000, 14_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips).toHaveLength(2);
    expect(result.clips[0].durationMs).toBe(8000); // a kept [0,8000)
    expect(result.clips[1].durationMs).toBe(6000); // b kept [4000,10000) of its own source
  });

  it("drops a clip entirely when the cut range fully contains it", () => {
    const clips = [
      buildClip({ id: "a", startMs: 0, durationMs: 10_000 }),
      buildClip({ id: "b", startMs: 10_000, durationMs: 10_000 }),
      buildClip({ id: "c", startMs: 20_000, durationMs: 10_000 }),
    ];
    // Cut 5000-25000 fully covers b.
    const result = removeRangeOnTrack(clips, TRACK_A, sourceDurationOf, 5000, 25_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("preserves clip identity (same id) when only trimming one edge, not splitting", () => {
    const result = removeRangeOnTrack([buildClip({ id: "a" })], TRACK_A, sourceDurationOf, 8000, 12_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clips[0].id).toBe("a");
  });

  it("never leaves a segment shorter than the minimum clip duration", () => {
    const result = removeRangeOnTrack([buildClip()], TRACK_A, sourceDurationOf, SOURCE_MS - 30, SOURCE_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const clip of result.clips) {
      expect(clip.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_MS);
    }
  });

  it("leaves clips on other tracks completely untouched", () => {
    const otherTrackClip = buildClip({ id: "other", trackId: TRACK_B, startMs: 2000, durationMs: 2000 });
    const result = removeRangeOnTrack([buildClip(), otherTrackClip], TRACK_A, sourceDurationOf, 2000, 6000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clips.find((c) => c.id === "other")).toEqual(otherTrackClip);
  });

  it("supports cutting multiple separate unwanted sections back to back", () => {
    const first = removeRangeOnTrack([buildClip()], TRACK_A, sourceDurationOf, 6000, 8000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.clips.reduce((sum, c) => sum + c.durationMs, 0)).toBe(8000);

    const second = removeRangeOnTrack(first.clips, TRACK_A, sourceDurationOf, 2000, 4000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.clips.reduce((sum, c) => sum + c.durationMs, 0)).toBe(6000);
  });
});

describe("addAudioPatch / removeAudioPatch", () => {
  it("adds a patch to the named clip only", () => {
    const other = buildClip({ id: "other", trackId: TRACK_B });
    const result = addAudioPatch([buildClip({ id: "a" }), other], "a", { startMs: 1000, endMs: 2000 });
    const patched = result.find((c) => c.id === "a") as MediaClip;
    expect(patched.audioPatches).toHaveLength(1);
    expect(patched.audioPatches[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(patched.audioPatches[0].id).toBeTruthy();
    expect((result.find((c) => c.id === "other") as MediaClip).audioPatches).toHaveLength(0);
  });

  it("removes a patch by id, leaving others untouched", () => {
    const withPatches = addAudioPatch([buildClip({ id: "a" })], "a", { startMs: 1000, endMs: 2000 });
    const withTwo = addAudioPatch(withPatches, "a", { startMs: 5000, endMs: 5500 });
    const patchIdToRemove = (withTwo[0] as MediaClip).audioPatches[0].id;
    const result = removeAudioPatch(withTwo, "a", patchIdToRemove);
    expect((result[0] as MediaClip).audioPatches).toHaveLength(1);
    expect((result[0] as MediaClip).audioPatches[0].startMs).toBe(5000);
  });
});

describe("audio patches survive trim/split by remapping to the new clip window", () => {
  it("splitClip keeps a patch entirely in the first half at the same offset", () => {
    const withPatch = addAudioPatch([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 1000, endMs: 1500 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toEqual([expect.objectContaining({ startMs: 1000, endMs: 1500 })]);
    expect(second.audioPatches).toHaveLength(0);
  });

  it("splitClip shifts a patch entirely in the second half to be relative to the new clip", () => {
    const withPatch = addAudioPatch([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 6000, endMs: 6500 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toHaveLength(0);
    expect(second.audioPatches).toEqual([expect.objectContaining({ startMs: 2000, endMs: 2500 })]); // 6000-4000 offset
  });

  it("splitClip clamps a patch that straddles the split point to each new clip's own bounds, never dropping the correction entirely", () => {
    const withPatch = addAudioPatch([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 3800, endMs: 4200 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toEqual([expect.objectContaining({ startMs: 3800, endMs: 4000 })]);
    expect(second.audioPatches).toEqual([expect.objectContaining({ startMs: 0, endMs: 200 })]);
  });

  it("removeRangeOnTrack remaps a surviving patch when the clip is trimmed from the front", () => {
    // Clip [0,10000), existing patch at [8000,8500). Cut [0,4000) trims the clip's front off,
    // so everything shifts left by 4000 in the new clip's own local coordinates.
    const withPatch = addAudioPatch([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 8000, endMs: 8500 });
    const result = removeRangeOnTrack(withPatch, TRACK_A, sourceDurationOf, 0, 4000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.clips[0] as MediaClip).audioPatches).toEqual([expect.objectContaining({ startMs: 4000, endMs: 4500 })]);
  });

  it("removeRangeOnTrack drops a patch that falls inside the removed range", () => {
    const withPatch = addAudioPatch([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 2000, endMs: 2500 });
    const result = removeRangeOnTrack(withPatch, TRACK_A, sourceDurationOf, 1000, 3000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allPatches = (result.clips as MediaClip[]).flatMap((c) => c.audioPatches);
    expect(allPatches).toHaveLength(0);
  });
});

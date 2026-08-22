import { describe, expect, it } from "vitest";
import {
  addAudioPatch,
  clampMoveStartMs,
  clipDurationFromTrim,
  duplicateClip,
  MIN_CLIP_DURATION_MS,
  moveClip,
  newVideoClip,
  removeAudioPatch,
  removeRangeOnTrack,
  repackTrack,
  rippleDeleteClip,
  splitClip,
  trimClipOnTrack,
  type MediaClip,
  fitContainRect,
  clampLogoPosition,
  positionOverlayClip,
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

// addAudioPatch validates and can refuse (see composition-invariants.test.ts
// for the refusal cases). These tests all use ranges that are meant to
// apply cleanly, so unwrap here and fail loudly if one unexpectedly doesn't.
function patched(clips: MediaClip[] | ReturnType<typeof buildClip>[], clipId: string, patch: { startMs: number; endMs: number }): MediaClip[] {
  const result = addAudioPatch(clips, clipId, patch);
  if (!result.ok) throw new Error(`expected the patch to apply, but: ${result.message}`);
  return result.clips as MediaClip[];
}

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
    const result = patched([buildClip({ id: "a" }), other], "a", { startMs: 1000, endMs: 2000 });
    const target = result.find((c) => c.id === "a") as MediaClip;
    expect(target.audioPatches).toHaveLength(1);
    expect(target.audioPatches[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
    expect(target.audioPatches[0].id).toBeTruthy();
    expect((result.find((c) => c.id === "other") as MediaClip).audioPatches).toHaveLength(0);
  });

  it("removes a patch by id, leaving others untouched", () => {
    const withPatches = patched([buildClip({ id: "a" })], "a", { startMs: 1000, endMs: 2000 });
    const withTwo = patched(withPatches, "a", { startMs: 5000, endMs: 5500 });
    const patchIdToRemove = (withTwo[0] as MediaClip).audioPatches[0].id;
    const result = removeAudioPatch(withTwo, "a", patchIdToRemove);
    expect((result[0] as MediaClip).audioPatches).toHaveLength(1);
    expect((result[0] as MediaClip).audioPatches[0].startMs).toBe(5000);
  });
});

describe("audio patches survive trim/split by remapping to the new clip window", () => {
  it("splitClip keeps a patch entirely in the first half at the same offset", () => {
    const withPatch = patched([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 1000, endMs: 1500 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toEqual([expect.objectContaining({ startMs: 1000, endMs: 1500 })]);
    expect(second.audioPatches).toHaveLength(0);
  });

  it("splitClip shifts a patch entirely in the second half to be relative to the new clip", () => {
    const withPatch = patched([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 6000, endMs: 6500 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toHaveLength(0);
    expect(second.audioPatches).toEqual([expect.objectContaining({ startMs: 2000, endMs: 2500 })]); // 6000-4000 offset
  });

  it("splitClip clamps a patch that straddles the split point to each new clip's own bounds, never dropping the correction entirely", () => {
    const withPatch = patched([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 3800, endMs: 4200 });
    const clip = withPatch[0] as MediaClip;
    const [first, second] = splitClip(clip, SOURCE_MS, 4000)!;
    expect(first.audioPatches).toEqual([expect.objectContaining({ startMs: 3800, endMs: 4000 })]);
    expect(second.audioPatches).toEqual([expect.objectContaining({ startMs: 0, endMs: 200 })]);
  });

  it("removeRangeOnTrack remaps a surviving patch when the clip is trimmed from the front", () => {
    // Clip [0,10000), existing patch at [8000,8500). Cut [0,4000) trims the clip's front off,
    // so everything shifts left by 4000 in the new clip's own local coordinates.
    const withPatch = patched([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 8000, endMs: 8500 });
    const result = removeRangeOnTrack(withPatch, TRACK_A, sourceDurationOf, 0, 4000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.clips[0] as MediaClip).audioPatches).toEqual([expect.objectContaining({ startMs: 4000, endMs: 4500 })]);
  });

  it("removeRangeOnTrack drops a patch that falls inside the removed range", () => {
    const withPatch = patched([buildClip({ startMs: 0, durationMs: 10_000 })], "clip", { startMs: 2000, endMs: 2500 });
    const result = removeRangeOnTrack(withPatch, TRACK_A, sourceDurationOf, 1000, 3000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allPatches = (result.clips as MediaClip[]).flatMap((c) => c.audioPatches);
    expect(allPatches).toHaveLength(0);
  });
});

describe("clampMoveStartMs", () => {
  it("allows a free drop into an empty track with no clamping", () => {
    expect(clampMoveStartMs([], 2000, 5000)).toBe(5000);
  });

  it("allows dropping into a gap between two other clips, leaving gaps on both sides", () => {
    const others = [
      { startMs: 0, durationMs: 2000 },
      { startMs: 10_000, durationMs: 2000 },
    ];
    expect(clampMoveStartMs(others, 1000, 5000)).toBe(5000);
  });

  it("clamps forward to just after the overlapping clip when dropped inside it, closer to that edge", () => {
    const others = [{ startMs: 1000, durationMs: 3000 }]; // occupies [1000, 4000)
    expect(clampMoveStartMs(others, 500, 3800)).toBe(4000); // dropped near the end, pushed just past it
  });

  it("clamps backward to just before the overlapping clip when dropped inside it, closer to that edge", () => {
    const others = [{ startMs: 1000, durationMs: 3000 }]; // occupies [1000, 4000)
    expect(clampMoveStartMs(others, 500, 1200)).toBe(500); // dropped near the start, pushed just before it
  });

  it("never produces a negative startMs even when dragged past zero", () => {
    expect(clampMoveStartMs([], 1000, -5000)).toBe(0);
  });

  it("clamps into the nearest gap large enough to fit, skipping ones that are too small", () => {
    const others = [
      { startMs: 0, durationMs: 1000 }, // gap after: [1000, 1200) — only 200ms, too small for a 500ms clip
      { startMs: 1200, durationMs: 100 },
      { startMs: 1300, durationMs: 5000 }, // occupies to 6300; trailing gap [6300, Infinity) always fits
    ];
    expect(clampMoveStartMs(others, 500, 1250)).toBe(6300);
  });

  it("ignores clips on other tracks entirely (handled by moveClip, not this function, but confirms the primitive doesn't itself assume same-track filtering)", () => {
    // clampMoveStartMs only ever receives same-track others by contract — this just
    // confirms the raw candidate passes through untouched when no others are given.
    expect(clampMoveStartMs([], 1000, 42_000)).toBe(42_000);
  });
});

describe("moveClip", () => {
  it("moves a clip to a free position, leaving a real gap where it used to be", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 2000 }), buildClip({ id: "b", startMs: 2000, durationMs: 2000 })];
    const next = moveClip(clips, "b", 10_000);
    expect((next.find((c) => c.id === "b") as MediaClip).startMs).toBe(10_000);
    expect((next.find((c) => c.id === "a") as MediaClip).startMs).toBe(0); // untouched
  });

  it("clamps the move to avoid overlapping a same-track clip", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 2000 }), buildClip({ id: "b", startMs: 5000, durationMs: 2000 })];
    const next = moveClip(clips, "b", 500); // would overlap "a" [0,2000) if placed at 500
    expect((next.find((c) => c.id === "b") as MediaClip).startMs).toBe(2000); // pushed to just after "a"
  });

  it("never lets a clip collide with one on a different track", () => {
    const clips = [buildClip({ id: "a", trackId: TRACK_A, startMs: 0, durationMs: 5000 }), buildClip({ id: "b", trackId: TRACK_B, startMs: 9000, durationMs: 2000 })];
    const next = moveClip(clips, "b", 1000); // fully overlaps "a" in time, but different track — must be untouched (no cross-track clamping)
    expect((next.find((c) => c.id === "b") as MediaClip).startMs).toBe(1000);
  });

  it("is a no-op when the clip id doesn't exist", () => {
    const clips = [buildClip({ id: "a" })];
    expect(moveClip(clips, "missing", 5000)).toBe(clips);
  });
});

describe("trimClipOnTrack", () => {
  it("recomputes durationMs when trimming the end — the whole point, and what was previously missing", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 10_000 })];
    const next = trimClipOnTrack(clips, "a", SOURCE_MS, 0, 3000)[0] as MediaClip;
    expect(next.durationMs).toBe(7000);
    expect(next.startMs).toBe(0); // end-edge trim never moves the left edge
    expect(next.trimOutMs).toBe(3000);
  });

  it("moves the clip's timeline start when trimming from the start, keeping its right edge fixed", () => {
    const clips = [buildClip({ id: "a", startMs: 4000, durationMs: 10_000 })];
    const next = trimClipOnTrack(clips, "a", SOURCE_MS, 2500, 0)[0] as MediaClip;
    expect(next.startMs).toBe(6500); // 4000 + 2500
    expect(next.durationMs).toBe(7500); // 10000 - 2500
    expect(next.startMs + next.durationMs).toBe(14_000); // right edge unchanged
  });

  it("clamps a start-edge trim so a clip can never be dragged back over its previous neighbour", () => {
    const clips = [
      buildClip({ id: "a", startMs: 0, durationMs: 5000 }),
      buildClip({ id: "b", startMs: 5000, durationMs: 10_000, trimInMs: 3000 }),
    ];
    // Asking to un-trim all the way back would put b's start at 2000, inside a.
    const next = trimClipOnTrack(clips, "b", SOURCE_MS, 0, 0).find((c) => c.id === "b") as MediaClip;
    expect(next.startMs).toBe(5000); // pinned to a's end, not 2000
    expect(next.trimInMs).toBe(3000); // trim given back only as far as there was room (i.e. none)
  });

  it("clamps an end-edge trim so a clip can never grow over its next neighbour", () => {
    const clips = [
      buildClip({ id: "a", startMs: 0, durationMs: 4000, trimOutMs: 6000 }),
      buildClip({ id: "b", startMs: 6000, durationMs: 4000 }),
    ];
    // Un-trimming a fully would make it 10s long, running to 10000 — past b's start.
    const next = trimClipOnTrack(clips, "a", SOURCE_MS, 0, 0).find((c) => c.id === "a") as MediaClip;
    expect(next.startMs + next.durationMs).toBeLessThanOrEqual(6000);
  });

  it("never lets the two trims collapse the clip below the minimum duration", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 10_000 })];
    const next = trimClipOnTrack(clips, "a", SOURCE_MS, 9900, 9900)[0] as MediaClip;
    expect(next.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_MS);
  });

  it("shifts audio patches with the new local zero when trimming from the start", () => {
    // Patch at local [5000,5500). Trimming 2000 off the front moves local
    // zero forward by 2000, so the patch must land at [3000,3500).
    const withPatch = patched([buildClip({ id: "a", startMs: 0, durationMs: 10_000 })], "a", { startMs: 5000, endMs: 5500 });
    const next = trimClipOnTrack(withPatch, "a", SOURCE_MS, 2000, 0)[0] as MediaClip;
    expect(next.audioPatches).toEqual([expect.objectContaining({ startMs: 3000, endMs: 3500 })]);
  });

  it("drops an audio patch that the trim removed entirely", () => {
    const withPatch = patched([buildClip({ id: "a", startMs: 0, durationMs: 10_000 })], "a", { startMs: 500, endMs: 1000 });
    const next = trimClipOnTrack(withPatch, "a", SOURCE_MS, 2000, 0)[0] as MediaClip;
    expect(next.audioPatches).toHaveLength(0);
  });

  it("is a no-op for an unknown clip or an unresolved source duration", () => {
    const clips = [buildClip({ id: "a" })];
    expect(trimClipOnTrack(clips, "missing", SOURCE_MS, 0, 1000)).toBe(clips);
    expect(trimClipOnTrack(clips, "a", 0, 0, 1000)).toBe(clips);
  });
});

describe("rippleDeleteClip", () => {
  it("removes the clip and pulls every later clip back by its duration", () => {
    const clips = [
      buildClip({ id: "a", startMs: 0, durationMs: 3000 }),
      buildClip({ id: "b", startMs: 3000, durationMs: 2000 }),
      buildClip({ id: "c", startMs: 5000, durationMs: 4000 }),
    ];
    const next = rippleDeleteClip(clips, "b");
    expect(next.map((c) => c.id)).toEqual(["a", "c"]);
    expect((next.find((c) => c.id === "c") as MediaClip).startMs).toBe(3000); // gap closed
    expect((next.find((c) => c.id === "a") as MediaClip).startMs).toBe(0); // earlier clip untouched
  });

  it("leaves clips on other tracks where they are", () => {
    const clips = [
      buildClip({ id: "a", trackId: TRACK_A, startMs: 0, durationMs: 3000 }),
      buildClip({ id: "b", trackId: TRACK_B, startMs: 5000, durationMs: 2000 }),
    ];
    const next = rippleDeleteClip(clips, "a");
    expect((next.find((c) => c.id === "b") as MediaClip).startMs).toBe(5000);
  });
});

describe("duplicateClip", () => {
  it("places the copy immediately after the original when there's room", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 3000 })];
    const next = duplicateClip(clips, "a");
    expect(next).toHaveLength(2);
    const copy = next.find((c) => c.id !== "a") as MediaClip;
    expect(copy.startMs).toBe(3000);
    expect(copy.durationMs).toBe(3000);
  });

  it("skips past an occupied slot rather than overlapping it", () => {
    const clips = [buildClip({ id: "a", startMs: 0, durationMs: 3000 }), buildClip({ id: "b", startMs: 3000, durationMs: 2000 })];
    const copy = duplicateClip(clips, "a").find((c) => c.id !== "a" && c.id !== "b") as MediaClip;
    expect(copy.startMs).toBe(5000); // after b, not on top of it
  });

  it("gives the copy's audio patches fresh ids so undoing one correction can't affect both clips", () => {
    const withPatch = patched([buildClip({ id: "a", startMs: 0, durationMs: 10_000 })], "a", { startMs: 1000, endMs: 1500 });
    const next = duplicateClip(withPatch, "a");
    const original = next.find((c) => c.id === "a") as MediaClip;
    const copy = next.find((c) => c.id !== "a") as MediaClip;
    expect(copy.audioPatches[0].id).not.toBe(original.audioPatches[0].id);
    expect(copy.audioPatches[0].startMs).toBe(1000); // same position within the clip
  });
});

describe("fitContainRect", () => {
  it("fills the box exactly when the canvas matches its aspect ratio", () => {
    const rect = fitContainRect({ width: 960, height: 540 }, { width: 1920, height: 1080 });
    expect(rect).toEqual({ left: 0, top: 0, width: 960, height: 540, scale: 0.5 });
  });

  it("letterboxes a canvas taller than the box, centring it horizontally", () => {
    // A 1:1 canvas in a 16:9 box: height is the limit, bars left and right.
    const rect = fitContainRect({ width: 1600, height: 900 }, { width: 1000, height: 1000 });
    expect(rect.height).toBe(900);
    expect(rect.width).toBe(900);
    expect(rect.left).toBe(350);
    expect(rect.top).toBe(0);
  });

  it("letterboxes a canvas wider than the box, centring it vertically", () => {
    const rect = fitContainRect({ width: 1000, height: 1000 }, { width: 2000, height: 1000 });
    expect(rect.width).toBe(1000);
    expect(rect.height).toBe(500);
    expect(rect.top).toBe(250);
    expect(rect.left).toBe(0);
  });

  it("returns a harmless zero rect before layout, instead of dividing by zero", () => {
    expect(fitContainRect({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      scale: 1,
    });
    expect(fitContainRect({ width: 800, height: 450 }, { width: 0, height: 0 }).scale).toBe(1);
  });
});

describe("clampLogoPosition", () => {
  const canvas = { width: 1920, height: 1080 };
  const logo = { width: 200, height: 100 };

  it("leaves a position that is already inside the frame alone", () => {
    expect(clampLogoPosition(300, 400, canvas, logo)).toEqual({ x: 300, y: 400 });
  });

  it("stops the logo at the right and bottom edges rather than letting it leave the frame", () => {
    expect(clampLogoPosition(5000, 5000, canvas, logo)).toEqual({ x: 1720, y: 980 });
  });

  it("stops at the top-left edge for negative drags", () => {
    expect(clampLogoPosition(-50, -80, canvas, logo)).toEqual({ x: 0, y: 0 });
  });

  it("pins a logo larger than the canvas to the origin instead of a negative position", () => {
    expect(clampLogoPosition(10, 10, { width: 100, height: 100 }, { width: 400, height: 400 })).toEqual({ x: 0, y: 0 });
  });

  it("rounds to whole pixels, since the renderer's overlay takes integer offsets", () => {
    expect(clampLogoPosition(100.6, 200.4, canvas, logo)).toEqual({ x: 101, y: 200 });
  });
});

describe("positionOverlayClip", () => {
  const canvas = { width: 1920, height: 1080 };
  const logo = { width: 200, height: 100 };

  function overlay(id: string, x: number, y: number) {
    return {
      id,
      trackId: "t_overlay",
      kind: "overlay" as const,
      mediaAssetId: "m1",
      startMs: 0,
      durationMs: 5000,
      trimInMs: 0,
      trimOutMs: 0,
      volume: 0,
      muted: true,
      speedPercent: 100,
      transform: { x, y, scale: 0.5, rotation: 0, opacity: 0.9 },
      audioPatches: [],
    };
  }

  it("moves only the targeted clip", () => {
    const next = positionOverlayClip([overlay("a", 0, 0), overlay("b", 10, 10)], "b", 500, 300, canvas, logo);
    expect(next[0]!.transform).toMatchObject({ x: 0, y: 0 });
    expect(next[1]!.transform).toMatchObject({ x: 500, y: 300 });
  });

  it("preserves scale and opacity — dragging changes position only", () => {
    const next = positionOverlayClip([overlay("a", 0, 0)], "a", 400, 200, canvas, logo);
    expect(next[0]!.transform.scale).toBe(0.5);
    expect(next[0]!.transform.opacity).toBe(0.9);
  });

  it("does not move the clip in time", () => {
    const next = positionOverlayClip([overlay("a", 0, 0)], "a", 400, 200, canvas, logo);
    expect(next[0]!.startMs).toBe(0);
    expect(next[0]!.durationMs).toBe(5000);
  });

  it("clamps a drag past the edge", () => {
    const next = positionOverlayClip([overlay("a", 0, 0)], "a", 99999, 99999, canvas, logo);
    expect(next[0]!.transform).toMatchObject({ x: 1720, y: 980 });
  });
});

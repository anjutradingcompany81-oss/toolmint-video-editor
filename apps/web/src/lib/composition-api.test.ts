import { describe, expect, it } from "vitest";
import { clipDurationMs, MIN_CLIP_DURATION_MS, newClip, removeRange, splitClip, type Clip } from "./composition-api";

function buildClip(overrides: Partial<Clip> = {}): Clip {
  return { id: overrides.id ?? "clip", mediaAssetId: "asset", trimInMs: 0, trimOutMs: 0, volume: 1, muted: false, ...overrides };
}

// A single 10s source clip, untrimmed, so timeline position == source position.
const SOURCE_MS = 10_000;
const sourceDurationOf = () => SOURCE_MS;

describe("newClip", () => {
  it("starts untrimmed, full volume, unmuted", () => {
    const clip = newClip("asset_1");
    expect(clip.mediaAssetId).toBe("asset_1");
    expect(clip.trimInMs).toBe(0);
    expect(clip.trimOutMs).toBe(0);
    expect(clip.volume).toBe(1);
    expect(clip.muted).toBe(false);
  });

  it("gives every new clip a unique id", () => {
    const a = newClip("asset_1");
    const b = newClip("asset_1");
    expect(a.id).not.toBe(b.id);
  });
});

describe("clipDurationMs", () => {
  it("subtracts both trims from the source duration", () => {
    expect(clipDurationMs({ trimInMs: 1000, trimOutMs: 2000 }, 10_000)).toBe(7000);
  });

  it("clamps to the minimum instead of going to zero or negative", () => {
    expect(clipDurationMs({ trimInMs: 4900, trimOutMs: 4900 }, 10_000)).toBe(MIN_CLIP_DURATION_MS);
  });
});

describe("splitClip", () => {
  it("splits into two complementary halves at the given offset", () => {
    const clip = buildClip();
    const result = splitClip(clip, SOURCE_MS, 4000);
    expect(result).not.toBeNull();
    const [first, second] = result!;
    expect(first.trimInMs).toBe(0);
    expect(first.trimOutMs).toBe(6000);
    expect(second.trimInMs).toBe(4000);
    expect(second.trimOutMs).toBe(0);
    expect(clipDurationMs(first, SOURCE_MS) + clipDurationMs(second, SOURCE_MS)).toBe(SOURCE_MS);
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

describe("removeRange", () => {
  it("rejects an end at or before the start", () => {
    const clips = [buildClip()];
    expect(removeRange(clips, sourceDurationOf, 5000, 5000).ok).toBe(false);
    expect(removeRange(clips, sourceDurationOf, 6000, 4000).ok).toBe(false);
  });

  it("rejects a negative start", () => {
    const clips = [buildClip()];
    const result = removeRange(clips, sourceDurationOf, -100, 1000);
    expect(result.ok).toBe(false);
  });

  it("rejects a range that overlaps nothing on the timeline", () => {
    // Single 10s clip; timeline only spans 0-10000, so 12000-15000 is out of range.
    const result = removeRange([buildClip()], sourceDurationOf, 12_000, 15_000);
    expect(result.ok).toBe(false);
  });

  it("cuts an unwanted middle section out of a single clip, joining the remainder with no gap", () => {
    // The star use case: one 10s clip, remove the middle 2s-6s (4s), leaving 6s total.
    const result = removeRange([buildClip()], sourceDurationOf, 2000, 6000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips).toHaveLength(2);
    const totalMs = result.clips.reduce((sum, c) => sum + clipDurationMs(c, SOURCE_MS), 0);
    expect(totalMs).toBe(6000); // 10s - 4s cut = 6s, no leftover gap

    // First half: original source [0, 2000). Second half: original source [6000, 10000).
    expect(result.clips[0].trimInMs).toBe(0);
    expect(clipDurationMs(result.clips[0], SOURCE_MS)).toBe(2000);
    expect(result.clips[1].trimOutMs).toBe(0);
    expect(clipDurationMs(result.clips[1], SOURCE_MS)).toBe(4000);
  });

  it("trims the tail off a clip when the cut starts inside it and ends at/after its end", () => {
    const clips = [buildClip({ id: "a" }), buildClip({ id: "b" })];
    // Timeline: a=[0,10000), b=[10000,20000). Cut 8000-14000 removes a's tail and b's head.
    const result = removeRange(clips, sourceDurationOf, 8000, 14_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips).toHaveLength(2);
    expect(clipDurationMs(result.clips[0], SOURCE_MS)).toBe(8000); // a kept [0,8000)
    expect(clipDurationMs(result.clips[1], SOURCE_MS)).toBe(6000); // b kept [4000,10000) of its own source
  });

  it("drops a clip entirely when the cut range fully contains it", () => {
    const clips = [buildClip({ id: "a" }), buildClip({ id: "b" }), buildClip({ id: "c" })];
    // a=[0,10000) b=[10000,20000) c=[20000,30000). Cut 5000-25000 fully covers b.
    const result = removeRange(clips, sourceDurationOf, 5000, 25_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(clipDurationMs(result.clips[0], SOURCE_MS)).toBe(5000); // a kept [0,5000)
    expect(clipDurationMs(result.clips[1], SOURCE_MS)).toBe(5000); // c kept [5000,10000) of its own source
  });

  it("removes a clip exactly matching the cut range", () => {
    const clips = [buildClip({ id: "a" }), buildClip({ id: "b" })];
    const result = removeRange(clips, sourceDurationOf, 10_000, 20_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clips.map((c) => c.id)).toEqual(["a"]);
  });

  it("leaves clips outside the cut range completely untouched", () => {
    const clips = [buildClip({ id: "a", volume: 0.5, muted: true }), buildClip({ id: "b" })];
    const result = removeRange(clips, sourceDurationOf, 15_000, 18_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clips[0]).toEqual(clips[0]);
  });

  it("never leaves a segment shorter than the minimum clip duration", () => {
    // Cutting the last 30ms of a clip would leave a sliver under MIN_CLIP_DURATION_MS — dropped instead.
    const result = removeRange([buildClip()], sourceDurationOf, SOURCE_MS - 30, SOURCE_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const clip of result.clips) {
      expect(clipDurationMs(clip, SOURCE_MS)).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_MS);
    }
  });

  it("supports cutting multiple separate unwanted sections back to back", () => {
    // Two sequential cuts on a 10s clip: first remove 6000-8000, then remove 2000-4000
    // from the resulting timeline — simulates a user repeating the workflow.
    const first = removeRange([buildClip()], sourceDurationOf, 6000, 8000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.clips.reduce((sum, c) => sum + clipDurationMs(c, SOURCE_MS), 0)).toBe(8000);

    const second = removeRange(first.clips, sourceDurationOf, 2000, 4000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.clips.reduce((sum, c) => sum + clipDurationMs(c, SOURCE_MS), 0)).toBe(6000);
  });
});

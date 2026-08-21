import { buildTimelineSegments } from "./timeline-segments.util";

describe("buildTimelineSegments", () => {
  it("maps source-coordinate chunks onto the clip's timeline position", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 1000, durationMs: 5000, trimInMs: 0 };
    const chunks = [{ startMs: 500, endMs: 1500, text: "hello there" }];
    const segments = buildTimelineSegments(clip, chunks);
    expect(segments).toEqual([
      { id: "clip_1:500", trackId: "track_1", clipId: "clip_1", mediaAssetId: "asset_1", startMs: 1500, endMs: 2500, text: "hello there" },
    ]);
  });

  it("shifts by trimInMs so a mid-clip trim still lands on the right timeline position", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 0, durationMs: 3000, trimInMs: 2000 };
    const chunks = [{ startMs: 2500, endMs: 3500, text: "trimmed in" }];
    const segments = buildTimelineSegments(clip, chunks);
    expect(segments[0].startMs).toBe(500);
    expect(segments[0].endMs).toBe(1500);
  });

  it("clips a chunk that only partially overlaps the clip's trimmed source range", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 0, durationMs: 1000, trimInMs: 0 };
    const chunks = [{ startMs: 500, endMs: 2000, text: "runs past the clip's end" }];
    const segments = buildTimelineSegments(clip, chunks);
    expect(segments).toHaveLength(1);
    expect(segments[0].endMs).toBe(1000); // clamped to the clip's own end
  });

  it("drops a chunk entirely outside the clip's trimmed source range", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 0, durationMs: 1000, trimInMs: 0 };
    const chunks = [{ startMs: 5000, endMs: 6000, text: "way outside" }];
    expect(buildTimelineSegments(clip, chunks)).toHaveLength(0);
  });

  it("drops a sliver of overlap shorter than 50ms as negligible", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 0, durationMs: 1000, trimInMs: 0 };
    const chunks = [{ startMs: 980, endMs: 1010, text: "barely overlaps" }];
    expect(buildTimelineSegments(clip, chunks)).toHaveLength(0);
  });

  it("preserves chunk text and processes multiple chunks in order", () => {
    const clip = { id: "clip_1", trackId: "track_1", mediaAssetId: "asset_1", startMs: 0, durationMs: 10000, trimInMs: 0 };
    const chunks = [
      { startMs: 0, endMs: 1000, text: "first" },
      { startMs: 1000, endMs: 2000, text: "second" },
    ];
    const segments = buildTimelineSegments(clip, chunks);
    expect(segments.map((s) => s.text)).toEqual(["first", "second"]);
  });
});

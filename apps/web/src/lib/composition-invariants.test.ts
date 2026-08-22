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

  it("cutting a marked range leaves a valid, gapless track", () => {
    let clips: Clip[] = [baseClip()];
    const result = removeRangeOnTrack(clips, TRACK, sourceDurationOf, 60_000, 90_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    clips = result.clips;
    expect(serverRejections(clips)).toEqual([]);
  });
});

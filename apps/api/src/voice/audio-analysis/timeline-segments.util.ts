// Maps an asset's cached transcript chunks (source-file coordinates) onto
// a specific clip's position on the timeline (timeline-absolute
// coordinates) — the same math voice-scan.processor.ts uses to build
// TranscriptSegment[] for repetition detection, factored out so the
// transcript-review endpoint (voice-scan.service.ts) can reconstruct the
// identical segment ids/positions without duplicating the arithmetic.
export interface CachedChunkLike {
  startMs: number;
  endMs: number;
  text: string;
}

export interface ClipPlacement {
  id: string;
  trackId: string;
  mediaAssetId: string;
  startMs: number;
  durationMs: number;
  trimInMs: number;
}

export interface TimelineTextSegment {
  id: string;
  trackId: string;
  clipId: string;
  mediaAssetId: string;
  startMs: number;
  endMs: number;
  // Source-local (asset-relative) start ms of the underlying transcript
  // chunk — the stable key for anything that must survive the clip being
  // moved/retrimmed on the timeline, e.g. a saved transcript-line edit
  // (see MediaAsset.transcriptEdits).
  sourceStartMs: number;
  text: string;
}

export function buildTimelineSegments(clip: ClipPlacement, chunks: CachedChunkLike[]): TimelineTextSegment[] {
  const clipSourceStart = clip.trimInMs;
  const clipSourceEnd = clip.trimInMs + clip.durationMs;

  const segments: TimelineTextSegment[] = [];
  for (const chunk of chunks) {
    const overlapStart = Math.max(chunk.startMs, clipSourceStart);
    const overlapEnd = Math.min(chunk.endMs, clipSourceEnd);
    if (overlapEnd - overlapStart < 50) continue; // negligible sliver, not a real usable segment

    segments.push({
      id: `${clip.id}:${chunk.startMs}`,
      trackId: clip.trackId,
      clipId: clip.id,
      mediaAssetId: clip.mediaAssetId,
      startMs: clip.startMs + (overlapStart - clipSourceStart),
      endMs: clip.startMs + (overlapEnd - clipSourceStart),
      sourceStartMs: chunk.startMs,
      text: chunk.text,
    });
  }
  return segments;
}

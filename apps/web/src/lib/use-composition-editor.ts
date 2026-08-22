"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import { getComposition, saveComposition, newVideoTrack, newOverlayTrack, type Clip, type MediaClip, type Timeline, type Track } from "./composition-api";

export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;
// Drag/trim gestures call withClips on every pointermove — dozens of times
// for one visual action. Without this, undo would take 40 presses to
// reverse a single drag. Edits arriving within this window of the previous
// one are folded into the same history entry instead of each getting their
// own; only the state from *before* the whole burst is kept for undo.
const HISTORY_COALESCE_MS = 500;
const HISTORY_LIMIT = 100;

// The editor UI (page.tsx and everything under it) works on a single video
// track — it predates the v2 multitrack rebuild and hasn't grown a real
// multitrack UI yet (that's a later phase). This hook is the seam: it keeps
// the *real* v2 Timeline (Track[] + Clip[], absolute positions) as the
// source of truth and exposes just that one track's clips, sorted by their
// own startMs. Positions are genuine absolute values owned by each edit
// operation — this hook no longer rewrites them (see withClips).
//
// Any other tracks/clips already in the timeline (e.g. created directly
// via the API, as multitrack features land server-side ahead of their UI)
// are preserved untouched across saves — this hook only ever reads or
// writes the one video track it manages.
export function useCompositionEditor(projectId: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [clips, setClips] = useState<MediaClip[]>([]);
  // The overlay track carries logo/watermark clips. It's kept separate from
  // the video track rather than folded into `clips` because the two obey
  // different rules: overlays composite *on top of* video and may sit
  // anywhere (including over a gap), so none of the video track's
  // adjacency/ripple logic should apply to them.
  const [overlayTrackId, setOverlayTrackId] = useState<string | null>(null);
  const [overlayClips, setOverlayClips] = useState<MediaClip[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipsRef = useRef(clips);
  const overlayClipsRef = useRef(overlayClips);
  const timelineRef = useRef(timeline);
  const trackIdRef = useRef(trackId);
  const overlayTrackIdRef = useRef(overlayTrackId);
  useEffect(() => {
    clipsRef.current = clips;
    overlayClipsRef.current = overlayClips;
    timelineRef.current = timeline;
    trackIdRef.current = trackId;
    overlayTrackIdRef.current = overlayTrackId;
  }, [clips, overlayClips, timeline, trackId, overlayTrackId]);

  // Undo snapshots BOTH tracks together, so undoing a logo placement can't
  // leave the video track from a different point in history (and vice
  // versa) — §36 requires undo to cover logo placement as well as cuts.
  type Snapshot = { video: MediaClip[]; overlay: MediaClip[] };
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const lastEditAt = useRef(0);

  function syncHistoryFlags() {
    setCanUndo(history.current.past.length > 0);
    setCanRedo(history.current.future.length > 0);
  }

  function resetHistory() {
    history.current = { past: [], future: [] };
    lastEditAt.current = 0;
    syncHistoryFlags();
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [proj, env] = await Promise.all([getProject(projectId), getComposition(projectId)]);
        if (cancelled) return;

        let loadedTimeline = env.composition;
        let videoTrack = loadedTimeline.tracks.find((t) => t.kind === "video");
        if (!videoTrack) {
          // Defensive only — every project is created with a default video
          // track, and the v1->v2 migration guarantees one too. Rather
          // than silently editing into a track that doesn't exist yet,
          // add one so the editor still has somewhere to work.
          videoTrack = newVideoTrack("Video 1", 0);
          loadedTimeline = { ...loadedTimeline, tracks: [...loadedTimeline.tracks, videoTrack] };
        }

        // The overlay track is created lazily — only projects that actually
        // use a logo need one, and adding an empty track to every project
        // would just be noise in the saved composition.
        const overlayTrack = loadedTimeline.tracks.find((t) => t.kind === "overlay") ?? null;

        setProject(proj);
        setTimeline(loadedTimeline);
        setTrackId(videoTrack.id);
        setClips(clipsOnTrack(loadedTimeline.clips, videoTrack.id));
        setOverlayTrackId(overlayTrack?.id ?? null);
        setOverlayClips(overlayTrack ? clipsOnTrack(loadedTimeline.clips, overlayTrack.id) : []);
        resetHistory();
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Couldn't load the editor.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // `extraTracks` lets a caller add a track (currently the lazily-created
  // overlay track) in the same save that first uses it, so the clip and the
  // track it references can never be persisted out of step — a clip whose
  // trackId doesn't exist is rejected by the schema.
  const scheduleSave = useCallback(
    (nextClips: MediaClip[], nextOverlayClips: MediaClip[], extraTracks: Track[] = []) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const current = timelineRef.current;
        const currentTrackId = trackIdRef.current;
        if (!current || !currentTrackId) return;
        setSaveStatus("saving");
        setSaveError(null);
        try {
          // Merge both managed tracks back into the full clip list — clips
          // on any track this editor doesn't manage are carried through
          // unchanged.
          const managedTrackIds = new Set([currentTrackId, overlayTrackIdRef.current].filter(Boolean) as string[]);
          const otherClips = current.clips.filter((c) => !managedTrackIds.has(c.trackId));
          const tracks = [...current.tracks, ...extraTracks.filter((t) => !current.tracks.some((existing) => existing.id === t.id))];
          const payload: Timeline = {
            ...current,
            tracks,
            clips: [...otherClips, ...nextClips, ...nextOverlayClips],
            updatedAt: new Date().toISOString(),
          };
          const env = await saveComposition(projectId, payload);
          setTimeline(env.composition);
          setSaveStatus("saved");
        } catch (err) {
          setSaveStatus("error");
          setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [projectId],
  );

  function pushHistory() {
    const now = Date.now();
    if (now - lastEditAt.current > HISTORY_COALESCE_MS) {
      history.current.past.push({ video: clipsRef.current, overlay: overlayClipsRef.current });
      if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
      history.current.future = [];
    }
    lastEditAt.current = now;
    syncHistoryFlags();
  }

  function withClips(mutate: (prev: MediaClip[]) => Clip[]) {
    const currentTrackId = trackIdRef.current;
    if (!timelineRef.current || !currentTrackId) return;
    const prevClips = clipsRef.current;
    const mutated = mutate(prevClips);
    // Deliberately NOT repacked. This used to run repackTrack() on every
    // single edit, which forces the whole track back-to-back with no gaps —
    // silently destroying any deliberate spacing the moment it was created,
    // so dragging a clip to a new position appeared to do nothing at all.
    // Clips carry absolute positions (schema v2) and the backend permits
    // gaps (only same-track *overlap* is rejected), so position is now
    // owned by whichever operation is being performed: moveClip and
    // trimClipOnTrack clamp against neighbours themselves, splitClip and
    // duplicateClip compute explicit positions, and the two operations that
    // genuinely mean "close the gap" — rippleDeleteClip and
    // removeRangeOnTrack — do their own rippling internally.
    //
    // The mutator only ever hands back clips for this one track, so this
    // narrowing is safe — it exists to satisfy the Clip union type without
    // scattering `as MediaClip` casts through every call site below.
    const nextClips = mutated.filter((c): c is MediaClip => c.trackId === currentTrackId && c.kind !== "text").sort((a, b) => a.startMs - b.startMs);

    pushHistory();
    setClips(nextClips);
    scheduleSave(nextClips, overlayClipsRef.current);
  }

  // Mutates the overlay (logo/watermark) track, creating it on first use.
  // Overlay clips never repack or ripple — a watermark sits wherever it was
  // placed, independent of what happens on the video track.
  function withOverlayClips(mutate: (prev: MediaClip[], overlayTrackId: string) => MediaClip[]) {
    const current = timelineRef.current;
    if (!current) return;

    const existingTrackId = overlayTrackIdRef.current;
    const newTracks: Track[] = [];
    let targetTrackId: string;
    if (existingTrackId) {
      targetTrackId = existingTrackId;
    } else {
      const highestOrder = current.tracks.reduce((max, t) => Math.max(max, t.order), 0);
      const track = newOverlayTrack("Logo", highestOrder + 1);
      targetTrackId = track.id;
      newTracks.push(track);
      setOverlayTrackId(track.id);
      overlayTrackIdRef.current = track.id;
    }

    const next = mutate(overlayClipsRef.current, targetTrackId).sort((a, b) => a.startMs - b.startMs);
    pushHistory();
    setOverlayClips(next);
    scheduleSave(clipsRef.current, next, newTracks);
  }

  function undo() {
    if (history.current.past.length === 0) return;
    const prev = history.current.past.pop()!;
    history.current.future.push({ video: clipsRef.current, overlay: overlayClipsRef.current });
    lastEditAt.current = 0; // next edit always starts a fresh entry, never coalesces across an undo
    syncHistoryFlags();
    setClips(prev.video);
    setOverlayClips(prev.overlay);
    scheduleSave(prev.video, prev.overlay);
  }

  function redo() {
    if (history.current.future.length === 0) return;
    const next = history.current.future.pop()!;
    history.current.past.push({ video: clipsRef.current, overlay: overlayClipsRef.current });
    lastEditAt.current = 0;
    syncHistoryFlags();
    setClips(next.video);
    setOverlayClips(next.overlay);
    scheduleSave(next.video, next.overlay);
  }

  return {
    project,
    timeline,
    trackId,
    clips,
    overlayTrackId,
    overlayClips,
    withOverlayClips,
    loading,
    loadError,
    saveStatus,
    saveError,
    withClips,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}

function clipsOnTrack(clips: Clip[], trackId: string): MediaClip[] {
  return clips
    .filter((c): c is MediaClip => c.trackId === trackId && c.kind !== "text")
    .sort((a, b) => a.startMs - b.startMs);
}

export type { Track };

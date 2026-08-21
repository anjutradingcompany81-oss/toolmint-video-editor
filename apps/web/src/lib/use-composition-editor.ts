"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import { getComposition, saveComposition, repackTrack, newVideoTrack, type Clip, type MediaClip, type Timeline, type Track } from "./composition-api";

export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;
// Drag/trim gestures call withClips on every pointermove — dozens of times
// for one visual action. Without this, undo would take 40 presses to
// reverse a single drag. Edits arriving within this window of the previous
// one are folded into the same history entry instead of each getting their
// own; only the state from *before* the whole burst is kept for undo.
const HISTORY_COALESCE_MS = 500;
const HISTORY_LIMIT = 100;

// The editor UI (page.tsx and everything under it) only knows about "the"
// timeline as a single flat, ordered list of video clips — it predates the
// v2 multitrack rebuild and hasn't been rebuilt into a real multitrack UI
// yet (that's a later phase). This hook is the seam: it keeps the *real*
// v2 Timeline (Track[] + Clip[], absolute positions) as the source of
// truth, but exposes just one track's clips as a plain ordered array, and
// re-derives that track's absolute positions from array order on every
// edit — so from the UI's point of view nothing changed, while what's
// actually persisted (and rendered) is genuine v2 data.
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipsRef = useRef(clips);
  const timelineRef = useRef(timeline);
  const trackIdRef = useRef(trackId);
  useEffect(() => {
    clipsRef.current = clips;
    timelineRef.current = timeline;
    trackIdRef.current = trackId;
  }, [clips, timeline, trackId]);

  const history = useRef<{ past: MediaClip[][]; future: MediaClip[][] }>({ past: [], future: [] });
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

        setProject(proj);
        setTimeline(loadedTimeline);
        setTrackId(videoTrack.id);
        setClips(clipsOnTrack(loadedTimeline.clips, videoTrack.id));
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

  const scheduleSave = useCallback(
    (nextClips: MediaClip[]) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const current = timelineRef.current;
        const currentTrackId = trackIdRef.current;
        if (!current || !currentTrackId) return;
        setSaveStatus("saving");
        setSaveError(null);
        try {
          // Merge this track's edited clips back into the full clip list —
          // clips on any other track are carried through unchanged.
          const otherClips = current.clips.filter((c) => c.trackId !== currentTrackId);
          const payload: Timeline = { ...current, clips: [...otherClips, ...nextClips], updatedAt: new Date().toISOString() };
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

  function withClips(mutate: (prev: MediaClip[]) => Clip[]) {
    const currentTrackId = trackIdRef.current;
    if (!timelineRef.current || !currentTrackId) return;
    const prevClips = clipsRef.current;
    const mutated = mutate(prevClips);
    // The mutator only ever hands back clips for this one track, so this
    // narrowing is safe — it exists to satisfy the Clip union type without
    // scattering `as MediaClip` casts through every call site below.
    const repacked = repackTrack(mutated, currentTrackId).filter((c): c is MediaClip => c.trackId === currentTrackId && c.kind !== "text");
    const now = Date.now();

    if (now - lastEditAt.current > HISTORY_COALESCE_MS) {
      history.current.past.push(prevClips);
      if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
      history.current.future = [];
    }
    lastEditAt.current = now;
    syncHistoryFlags();

    setClips(repacked);
    scheduleSave(repacked);
  }

  function undo() {
    if (history.current.past.length === 0) return;
    const prev = history.current.past.pop()!;
    history.current.future.push(clipsRef.current);
    lastEditAt.current = 0; // next edit always starts a fresh entry, never coalesces across an undo
    syncHistoryFlags();
    setClips(prev);
    scheduleSave(prev);
  }

  function redo() {
    if (history.current.future.length === 0) return;
    const next = history.current.future.pop()!;
    history.current.past.push(clipsRef.current);
    lastEditAt.current = 0;
    syncHistoryFlags();
    setClips(next);
    scheduleSave(next);
  }

  return { project, timeline, trackId, clips, loading, loadError, saveStatus, saveError, withClips, undo, redo, canUndo, canRedo };
}

function clipsOnTrack(clips: Clip[], trackId: string): MediaClip[] {
  return clips
    .filter((c): c is MediaClip => c.trackId === trackId && c.kind !== "text")
    .sort((a, b) => a.startMs - b.startMs);
}

export type { Track };

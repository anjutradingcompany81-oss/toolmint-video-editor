"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import {
  getComposition,
  saveComposition,
  newVideoTrack,
  newOverlayTrack,
  newAudioTrack,
  newAudioClip,
  DEFAULT_SUBTITLE_STYLE,
  type Clip,
  type MediaClip,
  type SubtitleCue,
  type SubtitleStyle,
  type Timeline,
  type Track,
} from "./composition-api";

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
  // Captions live on the timeline (not as clips) because they're one
  // ordered script the user edits as a whole, and because burn-in goes
  // through ffmpeg's subtitles filter rather than the compositing path.
  // The generated AI voice over gets its own audio track. Like the overlay
  // track it's created lazily and is never rippled or repacked — narration
  // is positioned against the timeline, so trimming a video clip must not
  // drag the voice over along with it.
  const [voiceOverTrackId, setVoiceOverTrackId] = useState<string | null>(null);
  const [voiceOverClips, setVoiceOverClips] = useState<MediaClip[]>([]);
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
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
  const voiceOverTrackIdRef = useRef(voiceOverTrackId);
  const voiceOverClipsRef = useRef(voiceOverClips);
  const subtitlesRef = useRef(subtitles);
  const subtitleStyleRef = useRef(subtitleStyle);
  useEffect(() => {
    clipsRef.current = clips;
    overlayClipsRef.current = overlayClips;
    timelineRef.current = timeline;
    trackIdRef.current = trackId;
    overlayTrackIdRef.current = overlayTrackId;
    voiceOverTrackIdRef.current = voiceOverTrackId;
    voiceOverClipsRef.current = voiceOverClips;
    subtitlesRef.current = subtitles;
    subtitleStyleRef.current = subtitleStyle;
  }, [clips, overlayClips, timeline, trackId, overlayTrackId, voiceOverTrackId, voiceOverClips, subtitles, subtitleStyle]);

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
        // Same laziness for narration. Matched by kind rather than by
        // name so renaming the track in a future multitrack UI can't
        // orphan the voice over the user already generated.
        const voiceOverTrack = loadedTimeline.tracks.find((t) => t.kind === "audio") ?? null;

        setProject(proj);
        setTimeline(loadedTimeline);
        setTrackId(videoTrack.id);
        setClips(clipsOnTrack(loadedTimeline.clips, videoTrack.id));
        setOverlayTrackId(overlayTrack?.id ?? null);
        setOverlayClips(overlayTrack ? clipsOnTrack(loadedTimeline.clips, overlayTrack.id) : []);
        setVoiceOverTrackId(voiceOverTrack?.id ?? null);
        setVoiceOverClips(voiceOverTrack ? clipsOnTrack(loadedTimeline.clips, voiceOverTrack.id) : []);
        // Projects saved before captions existed have neither field.
        setSubtitles(loadedTimeline.subtitles ?? []);
        setSubtitleStyle(loadedTimeline.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE);
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
    (
      nextClips: MediaClip[],
      nextOverlayClips: MediaClip[],
      extraTracks: Track[] = [],
      captions?: { subtitles: SubtitleCue[]; subtitleStyle: SubtitleStyle },
      nextVoiceOverClips?: MediaClip[],
    ) => {
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
          const managedTrackIds = new Set(
            [currentTrackId, overlayTrackIdRef.current, voiceOverTrackIdRef.current].filter(Boolean) as string[],
          );
          const otherClips = current.clips.filter((c) => !managedTrackIds.has(c.trackId));
          // Carried through on every save, exactly like captions, so an
          // unrelated clip edit can't drop the narration off the timeline.
          const voiceOver = nextVoiceOverClips ?? voiceOverClipsRef.current;
          const tracks = [...current.tracks, ...extraTracks.filter((t) => !current.tracks.some((existing) => existing.id === t.id))];
          const payload: Timeline = {
            ...current,
            tracks,
            clips: [...otherClips, ...nextClips, ...nextOverlayClips, ...voiceOver],
            // Captions are only overwritten by an edit that actually
            // changed them; every other save carries the current ones
            // through so a clip edit can't wipe the script.
            subtitles: captions?.subtitles ?? subtitlesRef.current,
            subtitleStyle: captions?.subtitleStyle ?? subtitleStyleRef.current,
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

  // Drops a freshly generated voice over onto the timeline, replacing any
  // previous one. Replace rather than append: regenerating after rewriting
  // a line is the normal case, and stacking the old narration under the
  // new one would have both speaking at once.
  //
  // Not routed through the undo stack — the audio it points at is produced
  // by a server-side job, so "undoing" back to a previous generation would
  // reference a different asset than the panel is showing.
  function placeVoiceOver(mediaAssetId: string, durationMs: number) {
    const current = timelineRef.current;
    if (!current) return;

    const existingTrackId = voiceOverTrackIdRef.current;
    const newTracks: Track[] = [];
    let targetTrackId: string;
    if (existingTrackId) {
      targetTrackId = existingTrackId;
    } else {
      const highestOrder = current.tracks.reduce((max, t) => Math.max(max, t.order), 0);
      const track = newAudioTrack("Voice over", highestOrder + 1);
      targetTrackId = track.id;
      newTracks.push(track);
      setVoiceOverTrackId(track.id);
      voiceOverTrackIdRef.current = track.id;
    }

    // startMs 0: the mixed file already has each line positioned at its
    // own timeline offset, with silence in between, so the track as a
    // whole starts at zero.
    const next = [newAudioClip(targetTrackId, mediaAssetId, 0, durationMs)];
    setVoiceOverClips(next);
    voiceOverClipsRef.current = next;
    scheduleSave(clipsRef.current, overlayClipsRef.current, newTracks, undefined, next);
  }

  function removeVoiceOver() {
    setVoiceOverClips([]);
    voiceOverClipsRef.current = [];
    scheduleSave(clipsRef.current, overlayClipsRef.current, [], undefined, []);
  }

  // Captions are edited as a script, so they're saved directly rather than
  // going through the clip-history stack — undoing a cut should not also
  // revert unrelated caption text.
  function updateSubtitles(next: SubtitleCue[], nextStyle?: SubtitleStyle) {
    const style = nextStyle ?? subtitleStyleRef.current;
    setSubtitles(next);
    if (nextStyle) setSubtitleStyle(nextStyle);
    subtitlesRef.current = next;
    subtitleStyleRef.current = style;
    scheduleSave(clipsRef.current, overlayClipsRef.current, [], { subtitles: next, subtitleStyle: style });
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
    voiceOverTrackId,
    voiceOverClips,
    placeVoiceOver,
    removeVoiceOver,
    subtitles,
    subtitleStyle,
    updateSubtitles,
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

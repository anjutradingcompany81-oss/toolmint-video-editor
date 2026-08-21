"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import { getComposition, saveComposition, type Clip, type Timeline } from "./composition-api";

export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;
// Drag/trim gestures call withClips on every pointermove — dozens of times
// for one visual action. Without this, undo would take 40 presses to
// reverse a single drag. Edits arriving within this window of the previous
// one are folded into the same history entry instead of each getting their
// own; only the state from *before* the whole burst is kept for undo.
const HISTORY_COALESCE_MS = 500;
const HISTORY_LIMIT = 100;

export function useCompositionEditor(projectId: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clipsRef = useRef(clips);
  const timelineRef = useRef(timeline);
  useEffect(() => {
    clipsRef.current = clips;
    timelineRef.current = timeline;
  }, [clips, timeline]);

  const history = useRef<{ past: Clip[][]; future: Clip[][] }>({ past: [], future: [] });
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
        setProject(proj);
        setTimeline(env.composition);
        setClips(env.composition.clips);
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
    (nextClips: Clip[]) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const current = timelineRef.current;
        if (!current) return;
        setSaveStatus("saving");
        setSaveError(null);
        try {
          const payload: Timeline = { ...current, clips: nextClips, updatedAt: new Date().toISOString() };
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

  function withClips(mutate: (prev: Clip[]) => Clip[]) {
    if (!timelineRef.current) return;
    const prevClips = clipsRef.current;
    const nextClips = mutate(prevClips);
    const now = Date.now();

    if (now - lastEditAt.current > HISTORY_COALESCE_MS) {
      history.current.past.push(prevClips);
      if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
      history.current.future = [];
    }
    lastEditAt.current = now;
    syncHistoryFlags();

    setClips(nextClips);
    scheduleSave(nextClips);
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

  return { project, timeline, clips, loading, loadError, saveStatus, saveError, withClips, undo, redo, canUndo, canRedo };
}

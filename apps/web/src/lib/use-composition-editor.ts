"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import { getComposition, saveComposition, type Composition, type Scene } from "./composition-api";

export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;
// Drag/trim gestures call withScenes on every pointermove — dozens of times
// for one visual action. Without this, undo would take 40 presses to
// reverse a single drag. Edits arriving within this window of the previous
// one are folded into the same history entry instead of each getting their
// own; only the state from *before* the whole burst is kept for undo.
const HISTORY_COALESCE_MS = 500;
const HISTORY_LIMIT = 100;

// Shared by the storyboard and timeline editors: both mutate the same
// `scenes` array and save the whole composition back. All edits flow through
// `withScenes`, which updates state and (re)schedules the debounced save
// directly in the caller — not via a useEffect watching `scenes` — for the
// same reason the auth refresh logic doesn't call setState synchronously at
// the top of an effect body: see api-client.ts's refreshSession().
export function useCompositionEditor(projectId: string, active: boolean) {
  const [project, setProject] = useState<Project | null>(null);
  const [composition, setComposition] = useState<Composition | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scenesRef = useRef(scenes);
  const compositionRef = useRef(composition);
  useEffect(() => {
    scenesRef.current = scenes;
    compositionRef.current = composition;
  }, [scenes, composition]);

  const history = useRef<{ past: Scene[][]; future: Scene[][] }>({ past: [], future: [] });
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
    if (!active) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [proj, env] = await Promise.all([getProject(projectId), getComposition(projectId)]);
        if (cancelled) return;
        setProject(proj);
        setComposition(env.composition);
        setScenes(env.composition.scenes);
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
  }, [active, projectId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const scheduleSave = useCallback(
    (nextScenes: Scene[]) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const current = compositionRef.current;
        if (!current) return;
        setSaveStatus("saving");
        setSaveError(null);
        try {
          const payload: Composition = { ...current, scenes: nextScenes, updatedAt: new Date().toISOString() };
          const env = await saveComposition(projectId, payload);
          setComposition(env.composition);
          setSaveStatus("saved");
        } catch (err) {
          setSaveStatus("error");
          setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [projectId],
  );

  function withScenes(mutate: (prev: Scene[]) => Scene[]) {
    if (!compositionRef.current) return;
    const prevScenes = scenesRef.current;
    const nextScenes = mutate(prevScenes);
    const now = Date.now();

    if (now - lastEditAt.current > HISTORY_COALESCE_MS) {
      history.current.past.push(prevScenes);
      if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
      history.current.future = [];
    }
    lastEditAt.current = now;
    syncHistoryFlags();

    setScenes(nextScenes);
    scheduleSave(nextScenes);
  }

  function undo() {
    if (history.current.past.length === 0) return;
    const prev = history.current.past.pop()!;
    history.current.future.push(scenesRef.current);
    lastEditAt.current = 0; // next edit always starts a fresh entry, never coalesces across an undo
    syncHistoryFlags();
    setScenes(prev);
    scheduleSave(prev);
  }

  function redo() {
    if (history.current.future.length === 0) return;
    const next = history.current.future.pop()!;
    history.current.past.push(scenesRef.current);
    lastEditAt.current = 0;
    syncHistoryFlags();
    setScenes(next);
    scheduleSave(next);
  }

  return { project, composition, scenes, loading, loadError, saveStatus, saveError, withScenes, undo, redo, canUndo, canRedo };
}

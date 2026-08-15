"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api-client";
import { getProject, type Project } from "./projects-api";
import { getComposition, saveComposition, type Composition, type Scene } from "./composition-api";

export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;

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

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [active, projectId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function withScenes(mutate: (prev: Scene[]) => Scene[]) {
    if (!composition) return;
    const nextScenes = mutate(scenes);
    setScenes(nextScenes);
    setSaveStatus("unsaved");

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const payload: Composition = { ...composition, scenes: nextScenes, updatedAt: new Date().toISOString() };
        const env = await saveComposition(projectId, payload);
        setComposition(env.composition);
        setSaveStatus("saved");
      } catch (err) {
        setSaveStatus("error");
        setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
      }
    }, SAVE_DEBOUNCE_MS);
  }

  return { project, composition, scenes, loading, loadError, saveStatus, saveError, withScenes };
}

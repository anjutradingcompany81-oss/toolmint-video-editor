"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { ApiError } from "@/lib/api-client";
import { getProject, type Project } from "@/lib/projects-api";
import { getComposition, saveComposition, newScene, type Composition, type Scene } from "@/lib/composition-api";
import SceneCard from "./scene-card";

type SaveStatus = "unsaved" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 1500;

export default function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { status } = useRequireAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [composition, setComposition] = useState<Composition | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
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
  }, [status, projectId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // All scene edits flow through here: update local state, mark unsaved, and
  // (re)schedule the debounced save — no effect watches `scenes` to do this,
  // since setState synchronously at the top of an effect body is the exact
  // footgun that caused the auth refresh race earlier in this project.
  function updateScenes(nextScenes: Scene[], baseComposition: Composition) {
    setScenes(nextScenes);
    setSaveStatus("unsaved");

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      setSaveError(null);
      try {
        const payload: Composition = { ...baseComposition, scenes: nextScenes, updatedAt: new Date().toISOString() };
        const env = await saveComposition(projectId, payload);
        setComposition(env.composition);
        setSaveStatus("saved");
      } catch (err) {
        setSaveStatus("error");
        setSaveError(err instanceof ApiError ? err.message : "Couldn't save changes.");
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function withScenes(mutate: (prev: Scene[]) => Scene[]) {
    if (!composition) return;
    updateScenes(mutate(scenes), composition);
  }

  function addScene() {
    withScenes((prev) => [...prev, newScene(prev.length)]);
  }

  function renameScene(id: string, name: string) {
    withScenes((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }

  function setDuration(id: string, durationMs: number) {
    withScenes((prev) => prev.map((s) => (s.id === id ? { ...s, durationMs } : s)));
  }

  function deleteScene(id: string) {
    withScenes((prev) => prev.filter((s) => s.id !== id));
  }

  function moveScene(index: number, direction: -1 | 1) {
    withScenes((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  if (status !== "authenticated" || loading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-sm text-[var(--tm-text-dim)]">Loading…</main>;
  }

  if (loadError || !project || !composition) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-red-400">{loadError ?? "Something went wrong."}</p>
        <Link href={`/dashboard/${projectId}`} className="mt-4 inline-block text-sm underline underline-offset-2">
          Back to project
        </Link>
      </main>
    );
  }

  const totalSeconds = scenes.reduce((sum, s) => sum + s.durationMs, 0) / 1000;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <Link href={`/dashboard/${projectId}`} className="text-sm text-[var(--tm-text-dim)] underline underline-offset-2">
            ← {project.title}
          </Link>
          <h1 className="mt-1 text-xl font-semibold">Storyboard</h1>
        </div>
        <SaveIndicator status={saveStatus} error={saveError} />
      </div>

      <p className="mt-1 text-xs text-[var(--tm-text-dim)]">
        {scenes.length} scene{scenes.length === 1 ? "" : "s"} · {totalSeconds.toFixed(1)}s total
      </p>

      <div className="mt-6 flex flex-col gap-3">
        {scenes.map((scene, index) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            index={index}
            count={scenes.length}
            onRename={(name) => renameScene(scene.id, name)}
            onDurationChange={(ms) => setDuration(scene.id, ms)}
            onMoveUp={() => moveScene(index, -1)}
            onMoveDown={() => moveScene(index, 1)}
            onDelete={() => deleteScene(scene.id)}
          />
        ))}
      </div>

      {scenes.length === 0 && (
        <p className="mt-4 text-sm text-[var(--tm-text-dim)]">No scenes yet — add your first one below.</p>
      )}

      <button
        onClick={addScene}
        className="mt-4 rounded-md border border-dashed border-[var(--tm-line)] px-4 py-2 text-sm text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)] hover:text-[var(--tm-text)]"
      >
        + Add scene
      </button>

      <p className="mt-8 text-xs text-[var(--tm-text-dim)]">
        The multi-track timeline (clips, transitions, voice-over) is the next editor module.
      </p>
    </main>
  );
}

function SaveIndicator({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "saving") return <span className="text-xs text-[var(--tm-text-dim)]">Saving…</span>;
  if (status === "saved") return <span className="text-xs text-[var(--tm-accent)]">Saved</span>;
  if (status === "error") return <span className="text-xs text-red-400" title={error ?? undefined}>Couldn&apos;t save</span>;
  return <span className="text-xs text-[var(--tm-text-dim)]">Unsaved changes</span>;
}

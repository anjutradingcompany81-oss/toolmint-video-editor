"use client";

import { use } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useCompositionEditor } from "@/lib/use-composition-editor";
import { newScene } from "@/lib/composition-api";
import SaveIndicator from "@/components/save-indicator";
import SceneCard from "./scene-card";

export default function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { status } = useRequireAuth();
  const { project, composition, scenes, loading, loadError, saveStatus, saveError, withScenes } = useCompositionEditor(
    projectId,
    status === "authenticated",
  );

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
          <div key={scene.id} className="flex flex-col gap-2">
            <SceneCard
              scene={scene}
              index={index}
              count={scenes.length}
              onRename={(name) => renameScene(scene.id, name)}
              onDurationChange={(ms) => setDuration(scene.id, ms)}
              onMoveUp={() => moveScene(index, -1)}
              onMoveDown={() => moveScene(index, 1)}
              onDelete={() => deleteScene(scene.id)}
            />
            <Link
              href={`/dashboard/${projectId}/edit/${scene.id}`}
              className="self-end text-xs text-[var(--tm-accent)] underline underline-offset-2"
            >
              Open timeline →
            </Link>
          </div>
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
    </main>
  );
}

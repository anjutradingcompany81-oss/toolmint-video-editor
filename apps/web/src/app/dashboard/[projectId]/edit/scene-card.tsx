"use client";

import { useState } from "react";
import type { Scene } from "@/lib/composition-api";

interface SceneCardProps {
  scene: Scene;
  index: number;
  count: number;
  onRename: (name: string) => void;
  onDurationChange: (durationMs: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}

export default function SceneCard({ scene, index, count, onRename, onDurationChange, onMoveUp, onMoveDown, onDelete }: SceneCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(scene.name);
  const [durationDraft, setDurationDraft] = useState(String(scene.durationMs / 1000));

  function saveName() {
    const name = nameDraft.trim();
    if (name && name !== scene.name) onRename(name);
    else setNameDraft(scene.name);
    setRenaming(false);
  }

  function saveDuration() {
    const seconds = Number(durationDraft);
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = Math.round(seconds * 1000);
      if (ms !== scene.durationMs) onDurationChange(ms);
    } else {
      setDurationDraft(String(scene.durationMs / 1000));
    }
  }

  function handleDelete() {
    if (window.confirm(`Delete "${scene.name}"? This can't be undone.`)) onDelete();
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3">
      <span className="w-6 shrink-0 text-center text-xs text-[var(--tm-text-dim)]">{index + 1}</span>

      <div className="flex flex-1 flex-col gap-1">
        {renaming ? (
          <input
            autoFocus
            className="rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1 text-sm"
            value={nameDraft}
            maxLength={200}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") {
                setNameDraft(scene.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <button className="w-fit text-left text-sm font-medium hover:underline" onClick={() => setRenaming(true)}>
            {scene.name}
          </button>
        )}

        <label className="flex items-center gap-2 text-xs text-[var(--tm-text-dim)]">
          Duration
          <input
            type="number"
            min="0.1"
            step="0.1"
            className="w-20 rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1 text-xs"
            value={durationDraft}
            onChange={(e) => setDurationDraft(e.target.value)}
            onBlur={saveDuration}
            onKeyDown={(e) => e.key === "Enter" && saveDuration()}
          />
          s
        </label>
      </div>

      <div className="flex shrink-0 flex-col gap-1 text-xs text-[var(--tm-text-dim)]">
        <button disabled={index === 0} onClick={onMoveUp} className="hover:text-[var(--tm-text)] disabled:opacity-30">
          Move up
        </button>
        <button disabled={index === count - 1} onClick={onMoveDown} className="hover:text-[var(--tm-text)] disabled:opacity-30">
          Move down
        </button>
      </div>

      <button onClick={handleDelete} className="shrink-0 text-xs text-red-400 hover:text-red-300">
        Delete
      </button>
    </div>
  );
}

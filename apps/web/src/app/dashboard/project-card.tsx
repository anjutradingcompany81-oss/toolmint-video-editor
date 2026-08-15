"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ASPECT_RATIO_LABELS,
  deleteProject,
  duplicateProject,
  updateProject,
  type Project,
} from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";

interface ProjectCardProps {
  project: Project;
  onChanged: (project: Project) => void;
  onDuplicated: (project: Project) => void;
  onDeleted: (id: string) => void;
}

export default function ProjectCard({ project, onChanged, onDuplicated, onDeleted }: ProjectCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRename() {
    const title = titleDraft.trim();
    if (!title || title === project.title) {
      setRenaming(false);
      setTitleDraft(project.title);
      return;
    }
    await run(async () => {
      const updated = await updateProject(project.id, { title });
      onChanged(updated);
      setRenaming(false);
    });
  }

  async function toggleArchive() {
    await run(async () => {
      const updated = await updateProject(project.id, { isArchived: !project.isArchived });
      onChanged(updated);
    });
  }

  async function handleDuplicate() {
    await run(async () => {
      const copy = await duplicateProject(project.id);
      onDuplicated(copy);
    });
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${project.title}"? This also deletes its uploaded media. This can't be undone.`)) return;
    await run(async () => {
      await deleteProject(project.id);
      onDeleted(project.id);
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-4">
      <div className="flex items-start justify-between gap-2">
        {renaming ? (
          <div className="flex flex-1 gap-2">
            <input
              autoFocus
              className="w-full rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1 text-sm"
              value={titleDraft}
              maxLength={200}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setTitleDraft(project.title);
                }
              }}
            />
            <button onClick={saveRename} disabled={busy} className="text-xs text-[var(--tm-accent)]">
              Save
            </button>
          </div>
        ) : (
          <Link href={`/dashboard/${project.id}`} className="font-medium hover:underline">
            {project.title}
          </Link>
        )}
        {project.isArchived && (
          <span className="shrink-0 rounded-full bg-[var(--tm-line)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--tm-text-dim)]">
            Archived
          </span>
        )}
      </div>

      <p className="text-xs text-[var(--tm-text-dim)]">
        {ASPECT_RATIO_LABELS[project.aspectRatio]} · {project.fps}fps · updated{" "}
        {new Date(project.updatedAt).toLocaleDateString()}
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-wrap gap-3 text-xs text-[var(--tm-text-dim)]">
        {!renaming && (
          <button disabled={busy} onClick={() => setRenaming(true)} className="hover:text-[var(--tm-text)]">
            Rename
          </button>
        )}
        <button disabled={busy} onClick={toggleArchive} className="hover:text-[var(--tm-text)]">
          {project.isArchived ? "Unarchive" : "Archive"}
        </button>
        <button disabled={busy} onClick={handleDuplicate} className="hover:text-[var(--tm-text)]">
          Duplicate
        </button>
        <button disabled={busy} onClick={handleDelete} className="text-red-400 hover:text-red-300">
          Delete
        </button>
      </div>
    </div>
  );
}

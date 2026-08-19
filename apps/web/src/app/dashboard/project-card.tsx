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
import { ArchiveIcon, ClapperboardIcon, CopyIcon, PencilIcon, TrashIcon } from "@/components/icons";

interface ProjectCardProps {
  project: Project;
  onChanged: (project: Project) => void;
  onDuplicated: (project: Project) => void;
  onDeleted: (id: string) => void;
}

// Real per-project thumbnails would need a rendered frame from the
// composition (project.thumbnailUrl exists in the schema for exactly that,
// but nothing generates one yet) — until then, a ratio-accurate placeholder
// swatch at least shows the project's shape at a glance, like Filmora's
// grid does with real frames.
const ASPECT_BOX: Record<Project["aspectRatio"], string> = {
  RATIO_16_9: "aspect-[16/9]",
  RATIO_9_16: "aspect-[9/16]",
  RATIO_1_1: "aspect-square",
  RATIO_4_5: "aspect-[4/5]",
  RATIO_21_9: "aspect-[21/9]",
  CUSTOM: "aspect-video",
};

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
    <div className="group flex flex-col overflow-hidden rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] transition-colors hover:border-[var(--tm-accent)]/60">
      <Link href={`/dashboard/${project.id}`} className={`relative flex items-center justify-center bg-black/40 ${ASPECT_BOX[project.aspectRatio]}`}>
        {project.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ClapperboardIcon width={28} height={28} className="text-[var(--tm-text-dim)]" />
        )}
        {project.isArchived && (
          <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--tm-text-dim)]">
            Archived
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {renaming ? (
          <div className="flex gap-2">
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
            <button onClick={saveRename} disabled={busy} className="shrink-0 text-xs text-[var(--tm-accent)]">
              Save
            </button>
          </div>
        ) : (
          <Link href={`/dashboard/${project.id}`} className="truncate text-sm font-medium hover:underline">
            {project.title}
          </Link>
        )}

        <p className="text-xs text-[var(--tm-text-dim)]">
          {ASPECT_RATIO_LABELS[project.aspectRatio]} · updated {new Date(project.updatedAt).toLocaleDateString()}
        </p>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="mt-auto flex items-center gap-3 pt-1 text-[var(--tm-text-dim)] opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {!renaming && (
            <button disabled={busy} onClick={() => setRenaming(true)} title="Rename" className="hover:text-[var(--tm-text)]">
              <PencilIcon />
            </button>
          )}
          <button disabled={busy} onClick={toggleArchive} title={project.isArchived ? "Unarchive" : "Archive"} className="hover:text-[var(--tm-text)]">
            <ArchiveIcon />
          </button>
          <button disabled={busy} onClick={handleDuplicate} title="Duplicate" className="hover:text-[var(--tm-text)]">
            <CopyIcon />
          </button>
          <button disabled={busy} onClick={handleDelete} title="Delete" className="ml-auto hover:text-red-400">
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

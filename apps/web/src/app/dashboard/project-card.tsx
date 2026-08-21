"use client";

import { useState } from "react";
import Link from "next/link";
import { deleteProject, duplicateProject, updateProject, type Project } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";
import { ArchiveIcon, ClapperboardIcon, CopyIcon, PencilIcon, TrashIcon } from "@/components/icons";

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
    <div className="group flex flex-col overflow-hidden rounded-lg border border-line bg-panel transition-colors hover:border-brand/60">
      <Link href={`/dashboard/${project.id}/edit`} className="relative flex aspect-video items-center justify-center bg-surface">
        {project.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <ClapperboardIcon width={28} height={28} className="text-ink-muted" />
        )}
        {project.isArchived && (
          <span className="absolute left-2 top-2 rounded-full bg-surface/90 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
            Archived
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {renaming ? (
          <div className="flex gap-2">
            <input
              autoFocus
              className="w-full rounded border border-line bg-surface px-2 py-1 text-sm"
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
            <button onClick={saveRename} disabled={busy} className="shrink-0 text-xs text-brand">
              Save
            </button>
          </div>
        ) : (
          <Link href={`/dashboard/${project.id}/edit`} className="truncate text-sm font-medium hover:underline">
            {project.title}
          </Link>
        )}

        <p className="text-xs text-ink-muted">updated {new Date(project.updatedAt).toLocaleDateString()}</p>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="mt-auto flex items-center gap-3 pt-1 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {!renaming && (
            <button disabled={busy} onClick={() => setRenaming(true)} title="Rename" className="hover:text-ink">
              <PencilIcon />
            </button>
          )}
          <button disabled={busy} onClick={toggleArchive} title={project.isArchived ? "Unarchive" : "Archive"} className="hover:text-ink">
            <ArchiveIcon />
          </button>
          <button disabled={busy} onClick={handleDuplicate} title="Duplicate" className="hover:text-ink">
            <CopyIcon />
          </button>
          <button disabled={busy} onClick={handleDelete} title="Delete" className="ml-auto hover:text-danger">
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

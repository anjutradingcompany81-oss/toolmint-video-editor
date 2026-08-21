"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useAuth } from "@/lib/auth-context";
import { apiFetch, ApiError } from "@/lib/api-client";
import { createProject, listProjects, type Project } from "@/lib/projects-api";
import { ClapperboardIcon, PlusIcon, SignOutIcon } from "@/components/icons";
import ProjectCard from "./project-card";

const inputClass =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-brand";

export default function DashboardPage() {
  const { user, status } = useRequireAuth();
  const { logout, refreshUser } = useAuth();
  const router = useRouter();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);

  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const data = await listProjects({ includeArchived, search: search || undefined });
        if (!cancelled) setProjects(data);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Couldn't load projects.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [status, includeArchived, search]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const chosenTitle = title.trim() || "Untitled project";
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ title: chosenTitle });
      router.push(`/dashboard/${project.id}/edit`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the project.");
      setCreating(false);
    }
  }

  async function handleResendVerification() {
    setResendState("sending");
    try {
      await apiFetch("/auth/resend-verification", { method: "POST" });
      setResendState("sent");
    } catch {
      setResendState("idle");
    }
  }

  if (status !== "authenticated" || !user) {
    return <main className="flex min-h-screen items-center justify-center bg-surface text-sm text-ink-muted">Loading…</main>;
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="flex w-56 shrink-0 flex-col justify-between border-r border-line bg-surface-2 p-4">
        <div>
          <p className="px-2 text-sm font-semibold tracking-wide">PROCUT</p>
          <nav className="mt-6 flex flex-col gap-1">
            <span className="flex items-center gap-2 rounded-md bg-brand/15 px-2.5 py-2 text-sm font-medium text-brand">
              <ClapperboardIcon /> Projects
            </span>
          </nav>
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {user.isGuest && (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-200">
              Guest account — projects here aren&apos;t tied to an email. Register to keep access after this session.
            </div>
          )}
          {!user.isGuest && !user.emailVerifiedAt && (
            <div className="rounded-md border border-line bg-surface px-2.5 py-2 text-[11px] text-ink-muted">
              Email not verified.{" "}
              {resendState === "sent" ? (
                <span className="text-success">Sent — check your inbox</span>
              ) : (
                <button
                  onClick={handleResendVerification}
                  disabled={resendState === "sending"}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  {resendState === "sending" ? "Sending…" : "Resend email"}
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 px-1">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/20 text-xs font-medium text-brand">
              {user.displayName.charAt(0).toUpperCase()}
            </span>
            <span className="truncate text-sm">{user.displayName}</span>
            <button onClick={() => logout()} title="Sign out" className="ml-auto shrink-0 text-ink-muted hover:text-ink">
              <SignOutIcon />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-panel p-6 shadow-lg">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
            <PlusIcon width={20} height={20} />
          </div>
          <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-sm font-medium">
            New project title
            <input
              className={inputClass}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled project"
            />
          </label>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-brand px-5 py-2 text-sm font-semibold text-ink transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create project"}
          </button>
          {createError && <p className="w-full text-sm text-danger">{createError}</p>}
        </form>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-semibold">Your projects</h1>
          <div className="flex items-center gap-4">
            <input
              className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-brand"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              Show archived
            </label>
          </div>
        </div>

        <div className="mt-4">
          {loading && <p className="text-sm text-ink-muted">Loading projects…</p>}
          {loadError && <p className="text-sm text-danger">{loadError}</p>}
          {!loading && !loadError && projects.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-line bg-panel/40 p-10 text-center">
              <p className="text-sm font-medium text-ink">
                {search ? "No projects match your search." : "Create your first project to get started."}
              </p>
              {!search && (
                <ol className="mx-auto mt-4 flex max-w-md flex-col gap-2 text-left text-sm text-ink-muted">
                  <li>
                    <span className="mr-2 text-brand">1.</span>Upload your video clips
                  </li>
                  <li>
                    <span className="mr-2 text-brand">2.</span>Arrange, trim, and split them on the timeline
                  </li>
                  <li>
                    <span className="mr-2 text-brand">3.</span>Export a single merged video
                  </li>
                </ol>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onChanged={(updated) => setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))}
                onDuplicated={(copy) => setProjects((prev) => [copy, ...prev])}
                onDeleted={(id) => setProjects((prev) => prev.filter((p) => p.id !== id))}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

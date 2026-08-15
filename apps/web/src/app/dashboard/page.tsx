"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useAuth } from "@/lib/auth-context";
import { apiFetch, ApiError } from "@/lib/api-client";
import { ASPECT_RATIO_LABELS, createProject, listProjects, type AspectRatio, type Project } from "@/lib/projects-api";
import ProjectCard from "./project-card";

const inputClass =
  "rounded-md border border-[var(--tm-line)] bg-[var(--tm-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--tm-accent)]";

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
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("RATIO_16_9");
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
    if (!title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ title: title.trim(), aspectRatio });
      router.push(`/dashboard/${project.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the project.");
    } finally {
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
    return <main className="mx-auto max-w-3xl px-6 py-10 text-sm text-[var(--tm-text-dim)]">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm tracking-wide text-[var(--tm-text-dim)]">TOOLMINT</p>
          <h1 className="mt-1 text-2xl font-semibold">Your projects</h1>
        </div>
        <div className="flex items-center gap-4 text-sm text-[var(--tm-text-dim)]">
          <span>{user.displayName}</span>
          <button onClick={() => logout()} className="underline underline-offset-2 hover:text-[var(--tm-text)]">
            Sign out
          </button>
        </div>
      </div>

      {!user.emailVerifiedAt && (
        <div className="mt-6 flex items-center justify-between gap-4 rounded-md border border-[var(--tm-line)] bg-[var(--tm-surface)] px-4 py-3 text-sm">
          <span className="text-[var(--tm-text-dim)]">Verify your email to keep full access to your account.</span>
          {resendState === "sent" ? (
            <span className="text-[var(--tm-accent)]">Sent — check your inbox</span>
          ) : (
            <button
              onClick={handleResendVerification}
              disabled={resendState === "sending"}
              className="shrink-0 underline underline-offset-2 hover:text-[var(--tm-text)]"
            >
              {resendState === "sending" ? "Sending…" : "Resend email"}
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleCreate} className="mt-8 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-4">
        <label className="flex flex-1 min-w-[200px] flex-col gap-1 text-sm">
          New project title
          <input
            className={inputClass}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled project"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Format
          <select className={inputClass} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}>
            {(Object.keys(ASPECT_RATIO_LABELS) as AspectRatio[])
              .filter((ratio) => ratio !== "CUSTOM")
              .map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ASPECT_RATIO_LABELS[ratio]}
                </option>
              ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={creating || !title.trim()}
          className="rounded-md bg-[var(--tm-accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create project"}
        </button>
        {createError && <p className="w-full text-sm text-red-400">{createError}</p>}
      </form>

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <input
          className={`${inputClass} flex-1 min-w-[200px]`}
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-[var(--tm-text-dim)]">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      <div className="mt-4">
        {loading && <p className="text-sm text-[var(--tm-text-dim)]">Loading projects…</p>}
        {loadError && <p className="text-sm text-red-400">{loadError}</p>}
        {!loading && !loadError && projects.length === 0 && (
          <p className="text-sm text-[var(--tm-text-dim)]">
            {search ? "No projects match your search." : "No projects yet — create your first one above."}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
  );
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useRequireAuth } from "@/lib/use-require-auth";
import { useAuth } from "@/lib/auth-context";
import { apiFetch, ApiError } from "@/lib/api-client";
import { ASPECT_RATIO_LABELS, createProject, listProjects, type AspectRatio, type Project } from "@/lib/projects-api";
import { ClapperboardIcon, PlusIcon, SignOutIcon } from "@/components/icons";
import ProjectCard from "./project-card";

const inputClass =
  "rounded-md border border-[var(--tm-line)] bg-black/20 px-3 py-2 text-sm text-[var(--tm-text)] outline-none placeholder:text-white/50 focus:border-white/60";

// Order mirrors how often each format actually gets used — landscape and
// vertical first (the two everyone reaches for), niche ratios after.
const QUICK_FORMATS: { ratio: AspectRatio; label: string; box: string }[] = [
  { ratio: "RATIO_16_9", label: "Landscape", box: "aspect-[16/9] w-8" },
  { ratio: "RATIO_9_16", label: "Vertical", box: "aspect-[9/16] w-4" },
  { ratio: "RATIO_1_1", label: "Square", box: "aspect-square w-6" },
  { ratio: "RATIO_4_5", label: "Portrait", box: "aspect-[4/5] w-5" },
  { ratio: "RATIO_21_9", label: "Cinematic", box: "aspect-[21/9] w-9" },
];

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

  async function create(chosenTitle: string, ratio: AspectRatio) {
    if (!chosenTitle.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const project = await createProject({ title: chosenTitle.trim(), aspectRatio: ratio });
      router.push(`/dashboard/${project.id}`);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create the project.");
      setCreating(false);
    }
  }

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    create(title, aspectRatio);
  }

  function quickCreate(ratio: AspectRatio) {
    create(title.trim() || "Untitled project", ratio);
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
    return <main className="flex min-h-screen items-center justify-center text-sm text-[var(--tm-text-dim)]">Loading…</main>;
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col justify-between border-r border-[var(--tm-line)] bg-[var(--tm-surface)] p-4">
        <div>
          <p className="px-2 text-sm font-semibold tracking-wide">TOOLMINT</p>
          <nav className="mt-6 flex flex-col gap-1">
            <span className="flex items-center gap-2 rounded-md bg-[var(--tm-accent)]/15 px-2.5 py-2 text-sm font-medium text-[var(--tm-accent)]">
              <ClapperboardIcon /> Projects
            </span>
          </nav>
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--tm-line)] pt-3">
          {user.isGuest && (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-2 text-[11px] text-amber-200">
              Guest account — projects here aren&apos;t tied to an email. Register to keep access after this session.
            </div>
          )}
          {!user.isGuest && !user.emailVerifiedAt && (
            <div className="rounded-md border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2.5 py-2 text-[11px] text-[var(--tm-text-dim)]">
              Email not verified.{" "}
              {resendState === "sent" ? (
                <span className="text-[var(--tm-accent)]">Sent — check your inbox</span>
              ) : (
                <button
                  onClick={handleResendVerification}
                  disabled={resendState === "sending"}
                  className="underline underline-offset-2 hover:text-[var(--tm-text)]"
                >
                  {resendState === "sending" ? "Sending…" : "Resend email"}
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 px-1">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--tm-accent)]/20 text-xs font-medium text-[var(--tm-accent)]">
              {user.displayName.charAt(0).toUpperCase()}
            </span>
            <span className="truncate text-sm">{user.displayName}</span>
            <button
              onClick={() => logout()}
              title="Sign out"
              className="ml-auto shrink-0 text-[var(--tm-text-dim)] hover:text-[var(--tm-text)]"
            >
              <SignOutIcon />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <form
          onSubmit={handleCreate}
          className="flex flex-wrap items-end gap-4 rounded-xl p-6 text-white shadow-lg"
          style={{ background: "linear-gradient(120deg, #0e9e77, #1fb5c7)" }}
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15">
            <PlusIcon width={20} height={20} />
          </div>
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-sm font-medium">
            New project title
            <input
              className={inputClass}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled project"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Format
            <select
              className={`${inputClass} [color-scheme:dark]`}
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
            >
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
            className="rounded-md bg-white px-5 py-2 text-sm font-semibold text-black disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create project"}
          </button>
          {createError && <p className="w-full text-sm text-red-100">{createError}</p>}
        </form>

        <div className="mt-4 flex flex-wrap gap-3">
          {QUICK_FORMATS.map((f) => (
            <button
              key={f.ratio}
              onClick={() => quickCreate(f.ratio)}
              disabled={creating}
              title={`New ${f.label.toLowerCase()} project`}
              className="flex w-24 flex-col items-center gap-2 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] py-3 text-xs text-[var(--tm-text-dim)] hover:border-[var(--tm-accent)]/60 hover:text-[var(--tm-text)] disabled:opacity-50"
            >
              <span className={`${f.box} rounded-sm border-2 border-current`} />
              {f.label}
            </button>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-lg font-semibold">Your projects</h1>
          <div className="flex items-center gap-4">
            <input
              className="rounded-md border border-[var(--tm-line)] bg-[var(--tm-surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--tm-accent)]"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className="flex items-center gap-2 text-sm text-[var(--tm-text-dim)]">
              <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
              Show archived
            </label>
          </div>
        </div>

        <div className="mt-4">
          {loading && <p className="text-sm text-[var(--tm-text-dim)]">Loading projects…</p>}
          {loadError && <p className="text-sm text-red-400">{loadError}</p>}
          {!loading && !loadError && projects.length === 0 && (
            <p className="text-sm text-[var(--tm-text-dim)]">
              {search ? "No projects match your search." : "No projects yet — create your first one above."}
            </p>
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

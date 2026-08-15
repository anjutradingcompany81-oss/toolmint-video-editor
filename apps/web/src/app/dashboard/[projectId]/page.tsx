"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRequireAuth } from "@/lib/use-require-auth";
import { ApiError } from "@/lib/api-client";
import { ASPECT_RATIO_LABELS, getProject, listMedia, type MediaAsset, type Project } from "@/lib/projects-api";
import MediaUpload from "./media-upload";
import MediaItem from "./media-item";

export default function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { status } = useRequireAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [proj, assets] = await Promise.all([getProject(projectId), listMedia(projectId)]);
        if (cancelled) return;
        setProject(proj);
        setMedia(assets);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 404 ? "Project not found." : "Couldn't load this project.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [status, projectId]);

  if (status !== "authenticated" || loading) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-sm text-[var(--tm-text-dim)]">Loading…</main>;
  }

  if (error || !project) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-red-400">{error ?? "Something went wrong."}</p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm underline underline-offset-2">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/dashboard" className="text-sm text-[var(--tm-text-dim)] underline underline-offset-2">
        ← All projects
      </Link>

      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{project.title}</h1>
        <Link
          href={`/dashboard/${projectId}/edit`}
          className="rounded-md bg-[var(--tm-accent)] px-4 py-2 text-sm font-medium text-black"
        >
          Open editor
        </Link>
      </div>
      <p className="mt-1 text-sm text-[var(--tm-text-dim)]">
        {ASPECT_RATIO_LABELS[project.aspectRatio]} · {project.fps}fps
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Media</h2>
        <div className="mt-3">
          <MediaUpload projectId={projectId} onUploaded={(asset) => setMedia((prev) => [asset, ...prev])} />
        </div>

        {media.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--tm-text-dim)]">No media uploaded yet.</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {media.map((asset) => (
              <MediaItem
                key={asset.id}
                projectId={projectId}
                asset={asset}
                onDeleted={(id) => setMedia((prev) => prev.filter((a) => a.id !== id))}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

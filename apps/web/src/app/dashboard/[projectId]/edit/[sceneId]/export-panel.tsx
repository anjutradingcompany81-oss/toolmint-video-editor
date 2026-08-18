"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-client";
import { ACTIVE_EXPORT_STATUSES, createExport, listExports, type ExportJob, type ExportResolution } from "@/lib/exports-api";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABEL: Record<ExportJob["status"], string> = {
  QUEUED: "Queued",
  PROCESSING: "Rendering",
  UPLOADING: "Uploading",
  COMPLETED: "Ready",
  FAILED: "Failed",
};

interface ExportPanelProps {
  projectId: string;
  sceneId: string;
}

export default function ExportPanel({ projectId, sceneId }: ExportPanelProps) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [resolution, setResolution] = useState<ExportResolution>("R720P");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listExports(projectId)
      .then((all) => {
        if (!cancelled) setJobs(all.filter((j) => j.sceneId === sceneId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, sceneId]);

  useEffect(() => {
    const active = jobs.some((j) => ACTIVE_EXPORT_STATUSES.includes(j.status));
    if (!active) return;
    const timer = setInterval(() => {
      listExports(projectId)
        .then((all) => setJobs(all.filter((j) => j.sceneId === sceneId)))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [jobs, projectId, sceneId]);

  async function handleExport() {
    setSubmitting(true);
    setError(null);
    try {
      const job = await createExport(projectId, sceneId, resolution);
      setJobs((prev) => [job, ...prev]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the export.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-3 rounded-md border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3 text-xs">
      <h2 className="font-medium uppercase tracking-wide text-[var(--tm-text-dim)]">Export</h2>

      <div className="flex items-center gap-2">
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value as ExportResolution)}
          className="rounded border border-[var(--tm-line)] bg-[var(--tm-bg)] px-2 py-1"
        >
          <option value="R720P">720p</option>
          <option value="R1080P">1080p</option>
        </select>
        <button
          onClick={handleExport}
          disabled={submitting}
          className="rounded-md bg-[var(--tm-accent)] px-3 py-1.5 font-medium text-black disabled:opacity-50"
        >
          {submitting ? "Starting…" : "Export scene"}
        </button>
      </div>

      {error && <p className="text-red-400">{error}</p>}

      <p className="text-[var(--tm-text-dim)]">
        Renders the video track (and audio track, if any) — clips must be back-to-back, with no gaps. Overlapping two
        clips creates a transition (set its style on the incoming clip).
      </p>

      {jobs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-center justify-between gap-2 rounded border border-[var(--tm-line)] px-2 py-1.5">
              <span>
                {job.resolution === "R1080P" ? "1080p" : "720p"} ·{" "}
                <span
                  className={
                    job.status === "COMPLETED" ? "text-[var(--tm-accent)]" : job.status === "FAILED" ? "text-red-400" : "text-[var(--tm-text-dim)]"
                  }
                >
                  {STATUS_LABEL[job.status]}
                </span>
                {ACTIVE_EXPORT_STATUSES.includes(job.status) && ` (${job.progress}%)`}
              </span>
              {job.status === "COMPLETED" && job.downloadUrl && (
                <a href={job.downloadUrl} className="shrink-0 underline underline-offset-2" download>
                  Download{job.outputByteSize ? ` (${formatBytes(job.outputByteSize)})` : ""}
                </a>
              )}
              {job.status === "FAILED" && job.errorMessage && (
                <span className="shrink-0 text-red-400" title={job.errorMessage}>
                  {job.errorMessage.length > 40 ? `${job.errorMessage.slice(0, 40)}…` : job.errorMessage}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

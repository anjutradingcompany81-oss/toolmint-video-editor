"use client";

import { useEffect, useRef, useState } from "react";
import {
  ACTIVE_EXPORT_STATUSES,
  cancelExport,
  createExport,
  getExport,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
  type ExportJob,
  type ExportQuality,
  type ExportResolution,
} from "@/lib/exports-api";
import { ApiError } from "@/lib/api-client";
import { DownloadIcon } from "@/components/icons";

interface ExportModalProps {
  projectId: string;
  projectTitle: string;
  open: boolean;
  onClose: () => void;
}

const POLL_MS = 1200;

const STAGE_LABEL: Record<ExportJob["status"], string> = {
  QUEUED: "Queued…",
  PROCESSING: "Processing…",
  UPLOADING: "Finishing up…",
  COMPLETED: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export default function ExportModal({ projectId, projectTitle, open, onClose }: ExportModalProps) {
  const [resolution, setResolution] = useState<ExportResolution>("R1080P");
  const [quality, setQuality] = useState<ExportQuality>("STANDARD");
  const [fileName, setFileName] = useState(projectTitle);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset the filename field to the project's title each time the modal
  // opens — adjusted during render (React's recommended pattern for
  // "reset state when a prop visibly changes") rather than in an effect,
  // so it takes effect in the same commit instead of one render late.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setFileName(projectTitle);
  }

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }

  function poll(jobId: string) {
    stopPolling();
    pollTimer.current = setInterval(async () => {
      try {
        const updated = await getExport(projectId, jobId);
        setJob(updated);
        if (!ACTIVE_EXPORT_STATUSES.includes(updated.status)) stopPolling();
      } catch {
        stopPolling();
      }
    }, POLL_MS);
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const created = await createExport(projectId, { resolution, quality, outputFileName: fileName.trim() || undefined });
      setJob(created);
      poll(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the export.");
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!job) return;
    try {
      const updated = await cancelExport(projectId, job.id);
      setJob(updated);
    } catch {
      // The next poll tick will reconcile the real state either way.
    }
  }

  function handleReset() {
    stopPolling();
    setJob(null);
    setError(null);
  }

  function handleClose() {
    if (job && ACTIVE_EXPORT_STATUSES.includes(job.status)) return; // don't hide an active render
    handleReset();
    onClose();
  }

  if (!open) return null;

  const active = job ? ACTIVE_EXPORT_STATUSES.includes(job.status) : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={handleClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-line bg-panel p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-ink">Export video</h2>

        {!job && (
          <>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Filename
              <input
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                maxLength={150}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Resolution
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ExportResolution)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
              >
                {(Object.keys(RESOLUTION_LABELS) as ExportResolution[]).map((r) => (
                  <option key={r} value={r}>
                    {RESOLUTION_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Quality
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as ExportQuality)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
              >
                {(Object.keys(QUALITY_LABELS) as ExportQuality[]).map((q) => (
                  <option key={q} value={q}>
                    {QUALITY_LABELS[q]}
                  </option>
                ))}
              </select>
            </label>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={handleClose} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink hover:border-brand/60">
                Cancel
              </button>
              <button
                onClick={handleStart}
                disabled={starting}
                className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-ink hover:bg-brand/90 disabled:opacity-50"
              >
                {starting ? "Starting…" : "Start export"}
              </button>
            </div>
          </>
        )}

        {job && (
          <>
            <p className="text-sm text-ink">{STAGE_LABEL[job.status]}</p>

            {(job.status === "QUEUED" || job.status === "PROCESSING" || job.status === "UPLOADING") && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${job.progress}%` }} />
              </div>
            )}

            {job.status === "FAILED" && <p className="text-sm text-danger">{job.errorMessage ?? "The export failed."}</p>}
            {job.status === "CANCELLED" && <p className="text-sm text-ink-muted">Export cancelled.</p>}

            <div className="flex justify-end gap-2 pt-1">
              {active && (
                <button onClick={handleCancel} className="rounded-md border border-danger/40 px-4 py-1.5 text-sm text-danger hover:bg-danger/10">
                  Cancel export
                </button>
              )}
              {!active && (
                <button onClick={handleReset} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink hover:border-brand/60">
                  {job.status === "COMPLETED" ? "Export again" : "Try again"}
                </button>
              )}
              {job.status === "COMPLETED" && job.downloadUrl && (
                <a
                  href={job.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-md bg-success px-4 py-1.5 text-sm font-medium text-ink hover:opacity-90"
                >
                  <DownloadIcon width={14} height={14} /> Download
                </a>
              )}
              {!active && job.status !== "COMPLETED" && (
                <button onClick={handleClose} className="rounded-md border border-line px-4 py-1.5 text-sm text-ink hover:border-brand/60">
                  Close
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

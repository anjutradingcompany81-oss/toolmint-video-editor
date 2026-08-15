"use client";

import { useState } from "react";
import { deleteMedia, type MediaAsset } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

const STATUS_LABEL: Record<MediaAsset["status"], string> = {
  UPLOADING: "Uploading…",
  PROCESSING: "Processing…",
  READY: "Ready",
  FAILED: "Failed",
};

interface MediaItemProps {
  projectId: string;
  asset: MediaAsset;
  onDeleted: (id: string) => void;
}

export default function MediaItem({ projectId, asset, onDeleted }: MediaItemProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm(`Delete "${asset.originalName}"? This can't be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMedia(projectId, asset.id);
      onDeleted(asset.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this file.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3">
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-[var(--tm-bg)]">
        {asset.kind === "IMAGE" && asset.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed S3 URL, not an optimizable static asset
          <img src={asset.previewUrl} alt={asset.originalName} className="h-full w-full object-cover" />
        ) : asset.kind === "VIDEO" && asset.previewUrl ? (
          <video src={asset.previewUrl} controls className="h-full w-full" />
        ) : asset.kind === "AUDIO" && asset.previewUrl ? (
          <audio src={asset.previewUrl} controls className="w-full px-3" />
        ) : (
          <span className="text-xs uppercase tracking-wide text-[var(--tm-text-dim)]">{asset.kind}</span>
        )}
      </div>

      <p className="truncate text-sm" title={asset.originalName}>
        {asset.originalName}
      </p>
      <p className="text-xs text-[var(--tm-text-dim)]">
        {formatBytes(asset.byteSize)} · {STATUS_LABEL[asset.status]}
      </p>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleDelete}
        disabled={busy}
        className="self-start text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
    </div>
  );
}

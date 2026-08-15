"use client";

import type { MediaAsset } from "@/lib/projects-api";

interface MediaLibraryProps {
  assets: MediaAsset[];
  armedId: string | null;
  onArm: (asset: MediaAsset) => void;
}

export default function MediaLibrary({ assets, armedId, onArm }: MediaLibraryProps) {
  const ready = assets.filter((a) => a.status === "READY");

  if (ready.length === 0) {
    return <p className="text-xs text-[var(--tm-text-dim)]">No media uploaded yet — add some from the project page.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {ready.map((asset) => (
        <button
          key={asset.id}
          onClick={() => onArm(asset)}
          className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${
            armedId === asset.id
              ? "border-[var(--tm-accent)] bg-[var(--tm-accent-soft,var(--tm-surface))] text-[var(--tm-accent)]"
              : "border-[var(--tm-line)] hover:border-[var(--tm-accent)]"
          }`}
          title={asset.originalName}
        >
          <span className="truncate">{asset.originalName}</span>
          <span className="shrink-0 uppercase tracking-wide text-[var(--tm-text-dim)]">{asset.kind}</span>
        </button>
      ))}
    </div>
  );
}

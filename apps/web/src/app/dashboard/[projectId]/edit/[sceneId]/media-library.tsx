"use client";

import type { DragEvent } from "react";
import type { MediaAsset } from "@/lib/projects-api";
import MediaThumb from "./media-thumb";

interface MediaLibraryProps {
  assets: MediaAsset[];
  armedId: string | null;
  onArm: (asset: MediaAsset) => void;
  onDragArm: (asset: MediaAsset) => void;
}

export default function MediaLibrary({ assets, armedId, onArm, onDragArm }: MediaLibraryProps) {
  const ready = assets.filter((a) => a.status === "READY");

  if (ready.length === 0) {
    return <p className="text-xs text-[var(--tm-text-dim)]">No media uploaded yet — add some from the project page.</p>;
  }

  function handleDragStart(e: DragEvent<HTMLButtonElement>, asset: MediaAsset) {
    // Deliberately not onArm — that one *toggles*, which would disarm this
    // asset mid-drag if it happened to already be armed from a previous
    // click. The timeline's drop handler reads the armed asset from shared
    // state rather than dataTransfer — browsers block reading dataTransfer
    // payload during dragover, only at drop, so this is what makes
    // "highlight the compatible tracks while dragging" possible.
    onDragArm(asset);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", asset.id);
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {ready.map((asset) => {
        const armed = armedId === asset.id;
        return (
          <button
            key={asset.id}
            draggable
            onDragStart={(e) => handleDragStart(e, asset)}
            onClick={() => onArm(asset)}
            title={`${asset.originalName} — drag onto the timeline, or click then click a track`}
            className={`group flex flex-col overflow-hidden rounded-md border text-left transition-colors ${
              armed ? "border-[var(--tm-accent)] ring-1 ring-[var(--tm-accent)]" : "border-[var(--tm-line)] hover:border-[var(--tm-accent)]/60"
            }`}
          >
            <div className="relative aspect-video w-full overflow-hidden bg-black">
              <MediaThumb asset={asset} className="h-full w-full object-cover" />
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[9px] uppercase tracking-wide text-white/80">
                {asset.kind}
              </span>
            </div>
            <span className="truncate px-1.5 py-1 text-[11px] text-[var(--tm-text)]">{asset.originalName}</span>
          </button>
        );
      })}
    </div>
  );
}

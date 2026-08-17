"use client";

import type { MouseEvent } from "react";
import type { TimelineItem } from "@/lib/composition-api";
import type { MediaAsset } from "@/lib/projects-api";

interface TimelineItemBlockProps {
  item: TimelineItem;
  media: MediaAsset | undefined;
  pxPerSecond: number;
  selected: boolean;
  onSelect: () => void;
}

export default function TimelineItemBlock({ item, media, pxPerSecond, selected, onSelect }: TimelineItemBlockProps) {
  const left = (item.startMs / 1000) * pxPerSecond;
  const width = Math.max(4, (item.durationMs / 1000) * pxPerSecond);
  const label = item.type === "text" ? item.content : (media?.originalName ?? "(missing media)");
  const title = item.type === "text" ? item.content : (media?.originalName ?? item.mediaAssetId);

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    // The track lane underneath also has a click handler (append clip on the
    // lane) — selecting an existing item must not also trigger that.
    e.stopPropagation();
    onSelect();
  }

  return (
    <button
      onClick={handleClick}
      style={{ left, width }}
      className={`absolute top-1 bottom-1 overflow-hidden rounded border px-2 text-left text-xs ${
        selected ? "border-[var(--tm-accent)] bg-[var(--tm-accent)]/20 text-[var(--tm-text)]" : "border-[var(--tm-line)] bg-[var(--tm-bg)]"
      }`}
      title={title}
    >
      <span className="block truncate leading-[2rem]">{label}</span>
    </button>
  );
}

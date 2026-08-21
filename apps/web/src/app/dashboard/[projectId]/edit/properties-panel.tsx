"use client";

import type { ClipLayoutEntry } from "@/lib/use-timeline-player";
import { MIN_CLIP_DURATION_MS } from "@/lib/composition-api";
import { TrashIcon } from "@/components/icons";
import { formatResolution, formatTimecode } from "./format";

interface PropertiesPanelProps {
  entry: ClipLayoutEntry | undefined;
  onSetTrim: (trimInMs: number, trimOutMs: number) => void;
  onSetVolume: (volume: number) => void;
  onSetMuted: (muted: boolean) => void;
  onReset: () => void;
  onDelete: () => void;
}

const inputClass = "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand";

export default function PropertiesPanel({ entry, onSetTrim, onSetVolume, onSetMuted, onReset, onDelete }: PropertiesPanelProps) {
  if (!entry) {
    return (
      <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface-2 p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Properties</h2>
        <p className="mt-4 text-sm text-ink-muted">Select a clip on the timeline to edit it.</p>
      </aside>
    );
  }

  const { clip, asset, startMs, durationMs } = entry;
  const sourceDurationMs = asset?.durationMs ?? durationMs + clip.trimInMs + clip.trimOutMs;
  const maxTrimIn = sourceDurationMs - clip.trimOutMs - MIN_CLIP_DURATION_MS;
  const maxTrimOut = sourceDurationMs - clip.trimInMs - MIN_CLIP_DURATION_MS;

  function handleTrimInSeconds(e: React.ChangeEvent<HTMLInputElement>) {
    const seconds = Number(e.target.value);
    if (Number.isNaN(seconds)) return;
    const trimInMs = Math.min(Math.max(maxTrimIn, 0), Math.max(0, Math.round(seconds * 1000)));
    onSetTrim(trimInMs, clip.trimOutMs);
  }

  function handleTrimOutSeconds(e: React.ChangeEvent<HTMLInputElement>) {
    const seconds = Number(e.target.value);
    if (Number.isNaN(seconds)) return;
    const trimOutMs = Math.min(Math.max(maxTrimOut, 0), Math.max(0, Math.round(seconds * 1000)));
    onSetTrim(clip.trimInMs, trimOutMs);
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-surface-2 p-4">
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-muted">Properties</h2>
        <p className="mt-2 truncate text-sm font-medium text-ink" title={asset?.originalName}>
          {asset?.originalName ?? "Unknown media"}
        </p>
        {asset && <p className="text-xs text-ink-muted">{formatResolution(asset.width, asset.height)}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-ink-muted">Start on timeline</p>
          <p className="tabular-nums text-ink">{formatTimecode(startMs, true)}</p>
        </div>
        <div>
          <p className="text-xs text-ink-muted">End on timeline</p>
          <p className="tabular-nums text-ink">{formatTimecode(startMs + durationMs, true)}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-ink-muted">Clip duration</p>
          <p className="tabular-nums text-ink">{formatTimecode(durationMs, true)}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Trim start (seconds into source)
          <input
            type="number"
            min={0}
            max={maxTrimIn / 1000}
            step={0.1}
            value={(clip.trimInMs / 1000).toFixed(2)}
            onChange={handleTrimInSeconds}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Trim end (seconds before source end)
          <input
            type="number"
            min={0}
            max={maxTrimOut / 1000}
            step={0.1}
            value={(clip.trimOutMs / 1000).toFixed(2)}
            onChange={handleTrimOutSeconds}
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-center justify-between text-xs text-ink-muted">
          Volume
          <span className="tabular-nums text-ink">{Math.round(clip.volume * 100)}%</span>
        </label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={clip.volume}
          onChange={(e) => onSetVolume(Number(e.target.value))}
          className="w-full accent-brand"
        />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={clip.muted} onChange={(e) => onSetMuted(e.target.checked)} />
          Muted
        </label>
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
        <button onClick={onReset} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:border-brand">
          Reset edits
        </button>
        <button
          onClick={onDelete}
          className="flex items-center justify-center gap-1.5 rounded-md border border-danger/40 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
        >
          <TrashIcon width={14} height={14} /> Delete clip
        </button>
      </div>
    </aside>
  );
}

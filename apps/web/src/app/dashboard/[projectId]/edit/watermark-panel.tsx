"use client";

import { useEffect, useState } from "react";
import { newWatermarkRegion, type WatermarkMode, type WatermarkRegion } from "@/lib/composition-api";
import { API_BASE_URL, getAccessToken } from "@/lib/api-client";
import { TrashIcon, PlusIcon } from "@/components/icons";
import { formatTimecode } from "./format";

interface WatermarkPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  regions: WatermarkRegion[];
  onChange: (next: WatermarkRegion[]) => void;
  canvasWidth: number;
  canvasHeight: number;
  playheadMs: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  hasClips: boolean;
}

export default function WatermarkPanel({
  open,
  onClose,
  projectId,
  regions,
  onChange,
  canvasWidth,
  canvasHeight,
  playheadMs,
  selectedId,
  onSelect,
  hasClips,
}: WatermarkPanelProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Object URLs are only freed when the browser is told to; without this
  // every preview would leak a blob for the life of the page.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function addRegion() {
    // Sized for a typical corner bug, and deliberately on the small side:
    // reconstruction quality falls off fast with area, so a box that
    // starts too big produces an ugly smear before the user has touched
    // anything. Easier to enlarge a small box than to discover why a big
    // one looked bad.
    const width = Math.round(canvasWidth * 0.11);
    const height = Math.round(canvasHeight * 0.08);
    const region = newWatermarkRegion(canvasWidth - width - Math.round(canvasWidth * 0.03), Math.round(canvasHeight * 0.04), width, height);
    onChange([...regions, region]);
    onSelect(region.id);
  }

  // Renders one real frame through the real ffmpeg filter. A CSS blur
  // would be quicker but would show something the export won't look like.
  async function previewRemoval() {
    setPreviewing(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/projects/${projectId}/exports/watermark-preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAccessToken() ?? ""}`, "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ timeMs: Math.round(playheadMs), regions }),
      });
      if (!res.ok) {
        let message = `Server returned ${res.status}`;
        try {
          const body = (await res.json()) as { message?: string | string[] };
          if (body.message) message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
        } catch {
          // Not JSON — keep the status-code message.
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't render the preview.");
    } finally {
      setPreviewing(false);
    }
  }

  function updateRegion(id: string, patch: Partial<WatermarkRegion>) {
    onChange(regions.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[400px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Remove Watermark</h2>
          <p className="text-[11px] text-ink-muted">Erase a logo or mark burned into your footage.</p>
        </div>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <button
            onClick={addRegion}
            disabled={!hasClips}
            title={hasClips ? "Add a box over the watermark" : "Add a video to the timeline first"}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink hover:bg-brand/90 disabled:opacity-40"
          >
            <PlusIcon width={13} height={13} /> Add removal area
          </button>

          <p className="rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] text-ink">
            Drag the box on the preview to cover the watermark, and drag its corners to resize. Arrow keys nudge it; hold Shift for ten pixels.
          </p>

          {/* Said plainly, because delogo is good but not magic and a user
              who expects a flawless erase on detailed footage would
              reasonably feel misled. */}
          <p className="rounded-md border border-line bg-panel/60 px-2.5 py-2 text-[11px] leading-snug text-ink-muted">
            <strong className="text-ink">Rebuild</strong> genuinely removes the mark, reconstructing the area from the pixels around it. It is
            invisible over flat backgrounds like sky or walls, and streaks over grass, foliage or text.{" "}
            <strong className="text-ink">Blur</strong> and <strong className="text-ink">Pixelate</strong> instead obscure the area — the mark stops
            being readable and the result looks deliberate rather than damaged, which usually beats a streak on busy footage. One catch: a solid,
            opaque logo stays visible as a pale patch under Blur, so use Rebuild for those. Keep the box tight to the mark either way.
          </p>

          {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          {regions.length === 0 ? (
            <p className="rounded-md border border-line bg-panel/40 px-3 py-4 text-center text-xs text-ink-muted">
              No removal areas yet.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  {regions.length} area{regions.length === 1 ? "" : "s"} on a {canvasWidth}×{canvasHeight} frame
                </p>
                {regions.map((region, index) => (
                  <div
                    key={region.id}
                    onClick={() => onSelect(region.id)}
                    className={`flex flex-col gap-1.5 rounded-md border bg-panel px-2.5 py-2 ${
                      selectedId === region.id ? "border-brand" : "border-line hover:border-brand/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-ink">Area {index + 1}</span>
                      <span className="font-mono tabular-nums text-ink-muted">
                        {region.x},{region.y} · {region.width}×{region.height}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onChange(regions.filter((r) => r.id !== region.id));
                        }}
                        title="Delete this removal area"
                        className="text-ink-muted hover:text-danger"
                      >
                        <TrashIcon width={12} height={12} />
                      </button>
                    </div>
                    {/* Numeric entry as well as dragging: matching a mark
                        that sits at known coordinates across several
                        projects is much easier typed than dragged. */}
                    <div className="flex gap-1">
                      {(
                        [
                          ["RECONSTRUCT", "Rebuild"],
                          ["BLUR", "Blur"],
                          ["PIXELATE", "Pixelate"],
                        ] as [WatermarkMode, string][]
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          onClick={(e) => {
                            e.stopPropagation();
                            updateRegion(region.id, { mode: value });
                          }}
                          className={`flex-1 rounded border px-1.5 py-1 text-[10px] ${
                            (region.mode ?? "RECONSTRUCT") === value
                              ? "border-brand bg-brand/15 text-brand"
                              : "border-line text-ink-muted hover:border-brand/50"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-4 gap-1.5">
                      {(["x", "y", "width", "height"] as const).map((field) => (
                        <label key={field} className="flex flex-col gap-0.5 text-[10px] uppercase text-ink-muted">
                          {field === "width" ? "W" : field === "height" ? "H" : field.toUpperCase()}
                          <input
                            type="number"
                            min={field === "width" || field === "height" ? 8 : 0}
                            value={region[field]}
                            onChange={(e) =>
                              updateRegion(region.id, { [field]: Math.max(0, Math.round(Number(e.target.value) || 0)) } as Partial<WatermarkRegion>)
                            }
                            className="w-full rounded border border-line bg-surface px-1 py-0.5 text-xs text-ink outline-none focus:border-brand"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={previewRemoval}
                disabled={previewing || !hasClips}
                className="rounded-md border border-line px-3 py-2 text-xs text-ink hover:border-brand disabled:opacity-40"
              >
                {previewing ? "Rendering frame…" : `Preview removal at ${formatTimecode(playheadMs)}`}
              </button>

              {previewUrl && (
                <div className="flex flex-col gap-1">
                  <p className="text-[11px] text-ink-muted">
                    Actual result at {formatTimecode(playheadMs)}, rendered with the same filter the export uses.
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="Frame with the watermark removed" className="w-full rounded border border-line" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

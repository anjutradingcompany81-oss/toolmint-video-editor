"use client";

import { useMemo, useState } from "react";
import type { MediaAsset } from "@/lib/projects-api";
import { logoPosition, newLogoClip, type LogoCorner, type MediaClip } from "@/lib/composition-api";
import { TrashIcon } from "@/components/icons";

const CORNERS: { value: LogoCorner; label: string }[] = [
  { value: "TOP_LEFT", label: "Top left" },
  { value: "TOP_RIGHT", label: "Top right" },
  { value: "BOTTOM_LEFT", label: "Bottom left" },
  { value: "BOTTOM_RIGHT", label: "Bottom right" },
  { value: "CUSTOM", label: "Custom" },
];

interface LogoPanelProps {
  open: boolean;
  onClose: () => void;
  images: MediaAsset[];
  overlayClips: MediaClip[];
  mediaById: Map<string, MediaAsset>;
  projectWidth: number;
  projectHeight: number;
  totalDurationMs: number;
  withOverlayClips: (mutate: (prev: MediaClip[], overlayTrackId: string) => MediaClip[]) => void;
  // Shared with the drag layer on the preview so selecting a logo in
  // either place highlights it in both.
  selectedLogoId: string | null;
  onSelectLogo: (clipId: string | null) => void;
}

export default function LogoPanel({
  open,
  onClose,
  images,
  overlayClips,
  mediaById,
  projectWidth,
  projectHeight,
  totalDurationMs,
  withOverlayClips,
  selectedLogoId,
  onSelectLogo,
}: LogoPanelProps) {
  const [corner, setCorner] = useState<LogoCorner>("TOP_RIGHT");
  const [scalePct, setScalePct] = useState(15);
  const [opacityPct, setOpacityPct] = useState(90);
  const [marginPx, setMarginPx] = useState(24);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const activeAssetId = selectedAssetId ?? images[0]?.id ?? null;
  const activeAsset = activeAssetId ? mediaById.get(activeAssetId) : undefined;

  // Scale is expressed as a percentage of the canvas WIDTH, which is what a
  // person actually means by "make the logo 15% of the frame" — the
  // renderer's transform.scale is a multiplier of the image's own pixel
  // size, so convert here rather than making the user do that arithmetic.
  const transformScale = useMemo(() => {
    if (!activeAsset?.width) return 1;
    return (projectWidth * (scalePct / 100)) / activeAsset.width;
  }, [activeAsset?.width, projectWidth, scalePct]);

  const renderedSize = useMemo(() => {
    const w = Math.round((activeAsset?.width ?? 0) * transformScale);
    const h = Math.round((activeAsset?.height ?? 0) * transformScale);
    return { width: w, height: h };
  }, [activeAsset?.width, activeAsset?.height, transformScale]);

  function addLogo() {
    if (!activeAssetId) return;
    const { x, y } = logoPosition(corner, { width: projectWidth, height: projectHeight }, renderedSize, marginPx);
    // The overlay track id is only known inside the mutator (the track is
    // created lazily on first use), so the new clip's id is captured from
    // there - the mutator runs synchronously, so it is set by the time
    // this returns.
    let createdId = "";
    withOverlayClips((prev, overlayTrackId) => {
      const clip = newLogoClip(overlayTrackId, activeAssetId, 0, Math.max(1000, totalDurationMs), {
        x,
        y,
        scale: transformScale,
        opacity: opacityPct / 100,
      });
      createdId = clip.id;
      return [...prev, clip];
    });
    // Select it straight away, so the ring on the preview shows which
    // logo the next drag will move.
    if (createdId) onSelectLogo(createdId);
  }

  function removeLogo(clipId: string) {
    withOverlayClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[380px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Logo / Watermark</h2>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {images.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-muted">
            Upload a PNG, JPEG or WebP in the media panel on the left, then come back here to place it.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-ink-muted">Image</p>
              <div className="grid grid-cols-3 gap-2">
                {images.map((img) => (
                  <button
                    key={img.id}
                    onClick={() => setSelectedAssetId(img.id)}
                    title={img.originalName}
                    className={`flex h-16 items-center justify-center overflow-hidden rounded-md border bg-panel p-1 ${
                      activeAssetId === img.id ? "border-brand ring-1 ring-brand" : "border-line hover:border-brand/50"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.previewUrl ?? ""} alt={img.originalName} className="max-h-full max-w-full object-contain" />
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Starting position
              <select
                value={corner}
                onChange={(e) => setCorner(e.target.value as LogoCorner)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
              >
                {CORNERS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <Slider label="Size (% of frame width)" value={scalePct} min={2} max={60} onChange={setScalePct} suffix="%" />
            <Slider label="Opacity" value={opacityPct} min={5} max={100} onChange={setOpacityPct} suffix="%" />
            <Slider label="Margin from edge" value={marginPx} min={0} max={200} onChange={setMarginPx} suffix="px" />

            <p className="rounded-md bg-panel px-2.5 py-1.5 text-[11px] text-ink-muted">
              Rendered at {renderedSize.width}×{renderedSize.height}px on a {projectWidth}×{projectHeight} frame.
            </p>

            <p className="rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-[11px] text-ink">
              After adding it, <strong>drag the logo on the video preview</strong> to place it exactly where you want. Arrow keys nudge it a pixel
              at a time; hold Shift for ten.
            </p>

            <button
              onClick={addLogo}
              disabled={!activeAssetId || totalDurationMs === 0}
              title={totalDurationMs === 0 ? "Add a video to the timeline first" : "Place this logo over the whole video"}
              className="rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink hover:bg-brand/90 disabled:opacity-40"
            >
              Add logo to video
            </button>

            {overlayClips.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                <p className="text-xs uppercase tracking-wide text-ink-muted">On this video</p>
                {overlayClips.map((clip) => {
                  const asset = mediaById.get(clip.mediaAssetId);
                  return (
                    <div
                      key={clip.id}
                      onClick={() => onSelectLogo(clip.id)}
                      className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border bg-panel px-2.5 py-2 text-xs ${
                        selectedLogoId === clip.id ? "border-brand" : "border-line hover:border-brand/50"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{asset?.originalName ?? "Logo"}</span>
                      {/* Live coordinates, so a drag has a readable result and
                          the same spot can be reproduced on another project. */}
                      <span className="shrink-0 font-mono tabular-nums text-ink-muted">
                        {Math.round(clip.transform.x)},{Math.round(clip.transform.y)}
                      </span>
                      <span className="shrink-0 text-ink-muted">{Math.round(clip.transform.opacity * 100)}%</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeLogo(clip.id);
                        }}
                        title="Remove this logo"
                        className="shrink-0 text-ink-muted hover:text-danger"
                      >
                        <TrashIcon width={13} height={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-muted">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums text-ink">
          {value}
          {suffix}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-brand" />
    </label>
  );
}

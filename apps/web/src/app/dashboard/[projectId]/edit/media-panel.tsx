"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import { deleteMedia, uploadMedia, type MediaAsset } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";
import { compareBySerial } from "@/lib/composition-api";
import { PlusIcon, TrashIcon } from "@/components/icons";
import MediaThumb from "./media-thumb";
import { formatBytes, formatResolution, formatTimecode } from "./format";

interface UploadTask {
  key: string;
  name: string;
  status: "uploading" | "error";
  error?: string;
}

interface MediaPanelProps {
  projectId: string;
  media: MediaAsset[];
  onMediaAdded: (asset: MediaAsset) => void;
  onMediaDeleted: (id: string) => void;
  onAddToTimeline: (assetId: string) => void;
  /** Adds several audio files at once, in the given order. */
  onAddAudioBatch: (assetIds: string[]) => void;
  /** Adds several video clips at once, in the given order. */
  onAddVideoBatch: (assetIds: string[]) => void;
}

export default function MediaPanel({ projectId, media, onMediaAdded, onMediaDeleted, onAddToTimeline, onAddAudioBatch, onAddVideoBatch }: MediaPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Uploads finish in whatever order the network returns them, so the media
  // list is not the order the files were named. Sorting by the number in
  // the filename is what makes "add them all" mean something predictable.
  const readyInSerialOrder = useCallback(
    (kind: MediaAsset["kind"]) =>
      media
        .filter((m) => m.kind === kind && m.status === "READY")
        .slice()
        .sort((a, b) => compareBySerial(a.originalName, b.originalName)),
    [media],
  );
  const audioInOrder = useMemo(() => readyInSerialOrder("AUDIO"), [readyInSerialOrder]);
  const videoInOrder = useMemo(() => readyInSerialOrder("VIDEO"), [readyInSerialOrder]);

  // Uploads finish in whatever order the network returns them, so the raw
  // list has scenes in an order nobody chose — 09, 06, 04, 01, 02. Showing
  // them by the number in the name is what makes a numbered set legible,
  // and the toggle is there because "most recently added" is genuinely the
  // more useful order while a batch is still being assembled.
  const [sortBySerial, setSortBySerial] = useState(true);
  const visibleMedia = useMemo(
    () => (sortBySerial ? [...media].sort((a, b) => compareBySerial(a.originalName, b.originalName)) : media),
    [media, sortBySerial],
  );

  async function uploadOne(file: File) {
    const key = `${file.name}-${file.size}-${Date.now()}`;
    setTasks((prev) => [...prev, { key, name: file.name, status: "uploading" }]);
    try {
      const asset = await uploadMedia(projectId, file);
      onMediaAdded(asset);
      setTasks((prev) => prev.filter((t) => t.key !== key));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Upload failed. Try again.";
      setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, status: "error", error: message } : t)));
    }
  }

  function uploadFiles(files: FileList | File[]) {
    Array.from(files).forEach((file) => uploadOne(file));
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }

  async function handleDelete(asset: MediaAsset) {
    if (!window.confirm(`Delete "${asset.originalName}"? This can't be undone.`)) return;
    setBusyId(asset.id);
    try {
      await deleteMedia(projectId, asset.id);
      onMediaDeleted(asset.id);
    } catch {
      // Deletion failures are rare (network blip) — leave the item in place
      // so the user can just try again rather than silently losing it.
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface-2">
      <div className="border-b border-line p-3">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
            dragging ? "border-brand bg-brand/10" : "border-line hover:border-brand/60"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,video/avi,.mp4,.mov,.webm,.mkv,.avi,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,.mp3,.wav,.aac,.m4a,.ogg"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <PlusIcon className="text-brand" />
          <p className="text-sm font-medium">Upload media</p>
          <p className="text-xs text-ink-muted">Drop files, or click to browse — video (MP4, MOV, WebM, AVI, MKV), images for a logo (PNG, JPG, WebP), or audio (MP3, WAV, AAC, M4A)</p>
        </div>

        {tasks.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {tasks.map((t) => (
              <li key={t.key} className="rounded-md border border-line bg-panel px-2 py-1.5 text-xs">
                <p className="truncate text-ink">{t.name}</p>
                {t.status === "uploading" ? (
                  <p className="text-ink-muted">Uploading…</p>
                ) : (
                  <p className="text-danger">{t.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The resolved order is shown before committing to it — the whole
          point is that they land in the numbered order, so it should be
          checkable first. */}
      <BulkAddBanner label="scenes" assets={videoInOrder} onAdd={() => onAddVideoBatch(videoInOrder.map((a) => a.id))} />
      <BulkAddBanner label="audio files" assets={audioInOrder} onAdd={() => onAddAudioBatch(audioInOrder.map((a) => a.id))} />

      <div className="flex-1 overflow-y-auto p-3">
        {media.length === 0 ? (
          <p className="mt-4 text-center text-sm text-ink-muted">No media yet — upload a video to get started.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between text-[11px] text-ink-muted">
              <span>{media.length} files</span>
              <button onClick={() => setSortBySerial((v) => !v)} className="rounded border border-line px-1.5 py-0.5 hover:border-brand">
                {sortBySerial ? "By number" : "Newest first"}
              </button>
            </div>
          <ul className="flex flex-col gap-2">
            {visibleMedia.map((asset) => (
              <li key={asset.id} className="group flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-2">
                <div className="flex gap-2">
                  <MediaThumb asset={asset} className="h-14 w-24 shrink-0 rounded object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink" title={asset.originalName}>
                      {asset.originalName}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {asset.durationMs != null ? formatTimecode(asset.durationMs) : "…"} · {formatResolution(asset.width, asset.height)}
                    </p>
                    <p className="text-xs text-ink-muted">{formatBytes(asset.byteSize)}</p>
                  </div>
                </div>
                {asset.status === "FAILED" && <p className="text-xs text-danger">Couldn&apos;t process this file.</p>}
                <div className="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  {asset.kind === "IMAGE" ? (
                    // Images aren't video-track clips — they're placed as a
                    // logo/watermark overlay, which needs position, size and
                    // opacity, so they're added from the Logo panel instead
                    // of dropped straight onto the timeline.
                    <span className="text-xs text-ink-muted">Use the Logo button to place this</span>
                  ) : (
                    <button
                      onClick={() => onAddToTimeline(asset.id)}
                      disabled={asset.status !== "READY"}
                      className="flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-medium text-ink hover:bg-brand/90 disabled:opacity-40"
                    >
                      <PlusIcon width={12} height={12} /> Add to timeline
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(asset)}
                    disabled={busyId === asset.id}
                    title="Delete"
                    className="ml-auto text-ink-muted hover:text-danger disabled:opacity-40"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </aside>
  );
}

// Offers a whole set of same-kind media as one ordered batch.
function BulkAddBanner({ label, assets, onAdd }: { label: string; assets: MediaAsset[]; onAdd: () => void }) {
  if (assets.length < 2) return null;
  const isVideo = label.includes("scene") || label.includes("video");
  return (
    <div className={`border-b border-line p-3 ${isVideo ? "bg-brand/10 border-brand/40" : "bg-panel/60"}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink flex items-center gap-1.5">
          {isVideo && <span>✨</span>}
          <span>{assets.length} {label} auto-detected</span>
        </p>
        <span className="rounded bg-brand/20 px-1.5 py-0.2 text-[10px] font-medium text-brand">Numbered</span>
      </div>
      <ol className="mt-1.5 max-h-24 overflow-y-auto text-[11px] text-ink-muted divide-y divide-line/30">
        {assets.map((asset, i) => (
          <li key={asset.id} className="flex items-center gap-1.5 py-0.5 truncate">
            <span className="shrink-0 font-mono text-[10px] font-bold text-brand">{i + 1}.</span>
            <span className="truncate text-ink/90" title={asset.originalName}>
              {asset.originalName}
            </span>
          </li>
        ))}
      </ol>
      <button
        onClick={onAdd}
        className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-brand px-2.5 py-1.5 text-xs font-semibold text-ink shadow hover:bg-brand/90 active:scale-[0.99] transition-all"
      >
        <span>⚡</span> Add All {assets.length} In Numbered Order
      </button>
    </div>
  );
}

"use client";

import { useRef, useState, type DragEvent } from "react";
import { uploadMedia, type MediaAsset } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";

interface MediaUploadProps {
  projectId: string;
  onUploaded: (asset: MediaAsset) => void;
}

export default function MediaUpload({ projectId, onUploaded }: MediaUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const asset = await uploadMedia(projectId, file);
      onUploaded(asset);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) upload(file);
  }

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-[var(--tm-accent)] bg-[var(--tm-surface)]" : "border-[var(--tm-line)]"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />
        <p className="text-sm">{uploading ? "Uploading…" : "Drop a file here, or click to browse"}</p>
        <p className="text-xs text-[var(--tm-text-dim)]">Video, image, audio, or PDF</p>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

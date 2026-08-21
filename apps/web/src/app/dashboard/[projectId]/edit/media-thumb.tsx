"use client";

import { useRef } from "react";
import type { MediaAsset } from "@/lib/projects-api";
import { VideoKindIcon } from "@/components/icons";

// Video elements don't paint a frame until something forces a decode — a
// tiny seek right after metadata loads is the standard trick to get a real
// first-frame thumbnail without a server-side thumbnailer.
function handleVideoLoaded(e: React.SyntheticEvent<HTMLVideoElement>) {
  const el = e.currentTarget;
  if (el.currentTime === 0) el.currentTime = Math.min(0.1, el.duration || 0.1);
}

export default function MediaThumb({ asset, className }: { asset: MediaAsset; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  if (asset.previewUrl) {
    return (
      <video
        ref={ref}
        src={asset.previewUrl}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={handleVideoLoaded}
        className={className}
      />
    );
  }

  return (
    <div className={`flex items-center justify-center bg-surface text-ink-muted ${className ?? ""}`}>
      <VideoKindIcon width={22} height={22} />
    </div>
  );
}

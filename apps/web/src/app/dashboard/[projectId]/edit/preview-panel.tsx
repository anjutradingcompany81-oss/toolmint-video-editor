"use client";

import { useRef } from "react";
import { MuteIcon, PauseIcon, PlayIcon, VolumeIcon } from "@/components/icons";
import type { useTimelinePlayer, ClipLayoutEntry } from "@/lib/use-timeline-player";
import { formatTimecode } from "./format";

// Simple chevron-style step icons — not worth adding to the shared icon set
// for two one-off glyphs used only here.
function StepBackIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 5L7 10l5.5 5" />
    </svg>
  );
}
function StepForwardIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 5L13 10l-5.5 5" />
    </svg>
  );
}
function FullscreenIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 8V5a1 1 0 0 0-1-1h-3M4 12v3a1 1 0 0 0 1 1h3M16 12v3a1 1 0 0 1-1 1h-3" />
    </svg>
  );
}

interface PreviewPanelProps {
  player: ReturnType<typeof useTimelinePlayer>;
  activeEntry: ClipLayoutEntry | undefined;
  totalDurationMs: number;
  fps: number;
  onSetActiveClipVolume: (volume: number) => void;
  onSetActiveClipMuted: (muted: boolean) => void;
}

export default function PreviewPanel({ player, activeEntry, totalDurationMs, fps, onSetActiveClipVolume, onSetActiveClipMuted }: PreviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { videoRef, playheadMs, playing, buffering, togglePlay, seekTo, stepFrame, handleTimeUpdate, handleEnded } = player;

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    seekTo(Number(e.target.value));
  }

  function toggleFullscreen() {
    if (!containerRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current.requestFullscreen().catch(() => undefined);
  }

  const hasClips = totalDurationMs > 0;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface p-6">
      <div ref={containerRef} className="relative flex aspect-video w-full max-w-3xl items-center justify-center overflow-hidden rounded-lg border border-line bg-black">
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
        />
        {!hasClips && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-ink-muted">
            <p className="text-sm">Add clips to the timeline to preview them here</p>
          </div>
        )}
        {hasClips && buffering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="text-xs text-ink">Loading…</span>
          </div>
        )}
      </div>

      <div className="flex w-full max-w-3xl flex-col gap-2">
        <input
          type="range"
          min={0}
          max={Math.max(1, totalDurationMs)}
          value={Math.min(playheadMs, totalDurationMs)}
          onChange={handleScrub}
          disabled={!hasClips}
          className="w-full accent-brand disabled:opacity-40"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={() => stepFrame(-1, fps)}
            disabled={!hasClips}
            title="Previous frame (Left arrow)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30"
          >
            <StepBackIcon />
          </button>
          <button
            onClick={togglePlay}
            disabled={!hasClips}
            title="Play/Pause (Space)"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-ink hover:bg-brand/90 disabled:opacity-40"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            onClick={() => stepFrame(1, fps)}
            disabled={!hasClips}
            title="Next frame (Right arrow)"
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-panel hover:text-ink disabled:opacity-30"
          >
            <StepForwardIcon />
          </button>

          <span className="font-mono text-xs tabular-nums text-ink-muted">
            {formatTimecode(playheadMs, true)} / {formatTimecode(totalDurationMs, true)}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => onSetActiveClipMuted(!activeEntry?.clip.muted)}
              disabled={!activeEntry}
              title={activeEntry?.clip.muted ? "Unmute clip" : "Mute clip"}
              className="text-ink-muted hover:text-ink disabled:opacity-30"
            >
              {activeEntry?.clip.muted ? <MuteIcon width={14} height={14} /> : <VolumeIcon width={14} height={14} />}
            </button>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={activeEntry?.clip.volume ?? 1}
              onChange={(e) => onSetActiveClipVolume(Number(e.target.value))}
              disabled={!activeEntry}
              title="Active clip volume"
              className="w-20 accent-brand disabled:opacity-30"
            />
            <button onClick={toggleFullscreen} disabled={!hasClips} title="Fullscreen" className="text-ink-muted hover:text-ink disabled:opacity-30">
              <FullscreenIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AspectRatio, MediaAsset } from "@/lib/projects-api";
import type { MediaTimelineItem, Scene, TextTimelineItem, Track, Transform } from "@/lib/composition-api";

const ASPECT_RATIOS: Record<AspectRatio, [number, number]> = {
  RATIO_16_9: [16, 9],
  RATIO_9_16: [9, 16],
  RATIO_1_1: [1, 1],
  RATIO_4_5: [4, 5],
  RATIO_21_9: [21, 9],
  CUSTOM: [16, 9],
};

const PREVIEW_MAX_PX = 480;
// Native playback drifts from the manually-driven playhead clock over time
// (seek latency, decode stalls); re-seek once the gap crosses this rather
// than every frame, which would otherwise fight the browser's own playback.
const DRIFT_CORRECTION_S = 0.3;

function previewDimensions(aspectRatio: AspectRatio, customWidth: number | null, customHeight: number | null): { width: number; height: number } {
  const ratio =
    aspectRatio === "CUSTOM" && customWidth && customHeight ? customWidth / customHeight : ASPECT_RATIOS[aspectRatio][0] / ASPECT_RATIOS[aspectRatio][1];
  return ratio >= 1
    ? { width: PREVIEW_MAX_PX, height: Math.round(PREVIEW_MAX_PX / ratio) }
    : { width: Math.round(PREVIEW_MAX_PX * ratio), height: PREVIEW_MAX_PX };
}

function isActive(item: { startMs: number; durationMs: number }, ms: number): boolean {
  return ms >= item.startMs && ms < item.startMs + item.durationMs;
}

function activeMediaItem(track: Track | undefined, ms: number): MediaTimelineItem | undefined {
  return track?.items.find((i): i is MediaTimelineItem => i.type !== "text" && isActive(i, ms));
}

// Every text track's active items, not just the first — unlike the single
// video/audio track this preview mirrors, overlapping captions/titles are
// meant to stack (matches the renderer's own text handling).
function activeTextItems(scene: Scene, ms: number): TextTimelineItem[] {
  return scene.tracks
    .filter((t) => t.type === "text")
    .flatMap((t) => t.items)
    .filter((i): i is TextTimelineItem => i.type === "text" && isActive(i, ms));
}

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

interface ScenePreviewProps {
  scene: Scene;
  media: MediaAsset[];
  aspectRatio: AspectRatio;
  customWidth: number | null;
  customHeight: number | null;
  endMs: number;
  playheadMs: number;
  onPlayheadChange: (ms: number) => void;
}

export default function ScenePreview({ scene, media, aspectRatio, customWidth, customHeight, endMs, playheadMs, onPlayheadChange }: ScenePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoElsRef = useRef(new Map<string, HTMLVideoElement>());
  const imageElsRef = useRef(new Map<string, HTMLImageElement>());
  const audioElsRef = useRef(new Map<string, HTMLAudioElement>());
  const activeVideoIdRef = useRef<string | null>(null);
  const activeAudioIdRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const rafRef = useRef<number | undefined>(undefined);
  const anchorRef = useRef({ wallStartMs: 0, playheadStartMs: 0 });

  const [playing, setPlaying] = useState(false);
  const dims = useMemo(() => previewDimensions(aspectRatio, customWidth, customHeight), [aspectRatio, customWidth, customHeight]);
  const mediaById = useMemo(() => new Map(media.map((a) => [a.id, a])), [media]);

  // rAF callbacks close over stale props otherwise; latest-ref pattern keeps
  // the loop reading current scene/media without restarting it every render.
  const sceneRef = useRef(scene);
  const mediaByIdRef = useRef(mediaById);
  useEffect(() => {
    sceneRef.current = scene;
    mediaByIdRef.current = mediaById;
  }, [scene, mediaById]);

  // A newly-created element has no decodable frame yet — the initial render()
  // call while it's still loading draws nothing. Redraw once it's actually
  // ready, using whatever playhead position was last requested.
  const lastRenderMsRef = useRef(0);

  function getVideoEl(asset: MediaAsset): HTMLVideoElement {
    let el = videoElsRef.current.get(asset.id);
    if (!el) {
      el = document.createElement("video");
      el.src = asset.previewUrl ?? "";
      el.muted = true; // visual only — the audio track (if any) is the sole audio source, matching the renderer
      el.playsInline = true;
      el.preload = "auto";
      el.addEventListener("loadeddata", () => render(lastRenderMsRef.current));
      el.addEventListener("seeked", () => render(lastRenderMsRef.current));
      videoElsRef.current.set(asset.id, el);
    }
    return el;
  }

  function getImageEl(asset: MediaAsset): HTMLImageElement {
    let el = imageElsRef.current.get(asset.id);
    if (!el) {
      el = new Image();
      el.onload = () => render(lastRenderMsRef.current);
      el.src = asset.previewUrl ?? "";
      imageElsRef.current.set(asset.id, el);
    }
    return el;
  }

  function getAudioEl(asset: MediaAsset): HTMLAudioElement {
    let el = audioElsRef.current.get(asset.id);
    if (!el) {
      el = document.createElement("audio");
      el.src = asset.previewUrl ?? "";
      el.preload = "auto";
      audioElsRef.current.set(asset.id, el);
    }
    return el;
  }

  function pauseAllVideo() {
    videoElsRef.current.forEach((el) => el.pause());
    activeVideoIdRef.current = null;
  }

  function pauseAllAudio() {
    audioElsRef.current.forEach((el) => el.pause());
    activeAudioIdRef.current = null;
  }

  function drawFrame(
    el: HTMLVideoElement | HTMLImageElement | null,
    naturalW: number,
    naturalH: number,
    transform: Transform | undefined,
    textItems: TextTimelineItem[],
  ) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (el && naturalW && naturalH && transform) {
      const fitScale = Math.min(canvas.width / naturalW, canvas.height / naturalH);
      const drawW = naturalW * fitScale * transform.scale;
      const drawH = naturalH * fitScale * transform.scale;

      ctx.save();
      ctx.globalAlpha = transform.opacity;
      ctx.translate(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y);
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.drawImage(el, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }

    // Rotation is deliberately not applied here — the render pipeline's
    // drawtext filter has no rotation option, and this preview is meant to
    // match what export actually produces, not what canvas can do.
    for (const item of textItems) {
      ctx.save();
      ctx.globalAlpha = item.transform.opacity;
      ctx.fillStyle = item.color;
      ctx.font = `${Math.round(item.fontSize * item.transform.scale)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item.content, canvas.width / 2 + item.transform.x, canvas.height / 2 + item.transform.y);
      ctx.restore();
    }
  }

  function render(ms: number) {
    lastRenderMsRef.current = ms;
    const currentScene = sceneRef.current;
    const currentMediaById = mediaByIdRef.current;
    const videoTrack = currentScene.tracks.find((t) => t.type === "video" && t.items.length > 0);
    const audioTrack = currentScene.tracks.find((t) => t.type === "audio" && t.items.length > 0);
    const vItem = activeMediaItem(videoTrack, ms);
    const aItem = activeMediaItem(audioTrack, ms);
    const textItems = activeTextItems(currentScene, ms);

    let drawEl: HTMLVideoElement | HTMLImageElement | null = null;
    let naturalW = 0;
    let naturalH = 0;

    const vAsset = vItem ? currentMediaById.get(vItem.mediaAssetId) : undefined;
    if (vItem && vAsset?.kind === "VIDEO" && vAsset.previewUrl) {
      const el = getVideoEl(vAsset);
      const targetTime = (ms - vItem.startMs + vItem.trimInMs) / 1000;
      if (playingRef.current) {
        if (activeVideoIdRef.current !== vItem.id) {
          videoElsRef.current.forEach((v, id) => {
            if (id !== vAsset.id) v.pause();
          });
          el.currentTime = targetTime;
          el.play().catch(() => undefined);
          activeVideoIdRef.current = vItem.id;
        } else if (Math.abs(el.currentTime - targetTime) > DRIFT_CORRECTION_S) {
          el.currentTime = targetTime;
        }
      } else {
        el.pause();
        // Guard against a no-op reassignment re-triggering 'seeked' in a loop.
        if (Math.abs(el.currentTime - targetTime) > 0.01) el.currentTime = targetTime;
      }
      drawEl = el;
      naturalW = el.videoWidth;
      naturalH = el.videoHeight;
    } else if (vItem && vAsset?.kind === "IMAGE" && vAsset.previewUrl) {
      pauseAllVideo();
      const el = getImageEl(vAsset);
      drawEl = el;
      naturalW = el.naturalWidth;
      naturalH = el.naturalHeight;
    } else {
      pauseAllVideo();
    }

    const aAsset = aItem ? currentMediaById.get(aItem.mediaAssetId) : undefined;
    if (aItem && aAsset?.kind === "AUDIO" && aAsset.previewUrl) {
      const el = getAudioEl(aAsset);
      el.muted = audioTrack?.muted ?? false;
      const targetTime = (ms - aItem.startMs + aItem.trimInMs) / 1000;
      if (playingRef.current) {
        if (activeAudioIdRef.current !== aItem.id) {
          audioElsRef.current.forEach((a, id) => {
            if (id !== aAsset.id) a.pause();
          });
          el.currentTime = targetTime;
          el.play().catch(() => undefined);
          activeAudioIdRef.current = aItem.id;
        } else if (Math.abs(el.currentTime - targetTime) > DRIFT_CORRECTION_S) {
          el.currentTime = targetTime;
        }
      } else {
        el.pause();
        el.currentTime = targetTime;
      }
    } else {
      pauseAllAudio();
    }

    drawFrame(drawEl, naturalW, naturalH, vItem?.transform, textItems);
  }

  function tick() {
    if (!playingRef.current) return;
    const now = performance.now();
    const elapsed = anchorRef.current.playheadStartMs + (now - anchorRef.current.wallStartMs);
    if (elapsed >= endMs) {
      playingRef.current = false;
      setPlaying(false);
      pauseAllVideo();
      pauseAllAudio();
      onPlayheadChange(endMs);
      render(endMs);
      return;
    }
    onPlayheadChange(elapsed);
    render(elapsed);
    rafRef.current = requestAnimationFrame(tick);
  }

  function handlePlayPause() {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      pauseAllVideo();
      pauseAllAudio();
      render(playheadMs);
      return;
    }
    const startMs = playheadMs >= endMs ? 0 : playheadMs;
    if (startMs !== playheadMs) onPlayheadChange(startMs);
    anchorRef.current = { wallStartMs: performance.now(), playheadStartMs: startMs };
    playingRef.current = true;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(tick);
  }

  // Scrubbing while paused (ruler click, split, load) redraws immediately.
  useEffect(() => {
    if (!playing) render(playheadMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadMs, playing, scene, media]);

  useEffect(() => {
    const videoEls = videoElsRef.current;
    const audioEls = audioElsRef.current;
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      videoEls.forEach((el) => {
        el.pause();
        el.src = "";
      });
      audioEls.forEach((el) => {
        el.pause();
        el.src = "";
      });
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-surface)] p-3">
      <canvas ref={canvasRef} width={dims.width} height={dims.height} className="rounded bg-black" style={{ width: dims.width, height: dims.height }} />
      <div className="flex w-full items-center justify-between text-xs text-[var(--tm-text-dim)]">
        <button
          onClick={handlePlayPause}
          className="rounded-md border border-[var(--tm-line)] px-3 py-1 font-medium text-[var(--tm-text)] hover:border-[var(--tm-accent)]"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span>
          {formatTime(playheadMs)} / {formatTime(endMs)}
        </span>
      </div>
    </div>
  );
}

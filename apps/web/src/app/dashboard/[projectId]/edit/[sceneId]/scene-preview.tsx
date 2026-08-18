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

// Usually 0-1 items; 2 during a transition's overlap window. A third
// simultaneously-active item would mean two transitions overlapping each
// other (very short clips with back-to-back transitions) — not supported,
// so it's truncated rather than handled incorrectly.
function activeMediaItems(track: Track | undefined, ms: number): MediaTimelineItem[] {
  if (!track) return [];
  return track.items
    .filter((i): i is MediaTimelineItem => i.type !== "text" && isActive(i, ms))
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, 2);
}

// 0 at the start of the overlap (outgoing fully visible/audible), 1 at the
// end (incoming fully visible/audible).
function transitionProgress(outgoing: MediaTimelineItem, incoming: MediaTimelineItem, ms: number): number {
  const overlapStart = incoming.startMs;
  const overlapEnd = outgoing.startMs + outgoing.durationMs;
  const span = Math.max(1, overlapEnd - overlapStart);
  return Math.min(1, Math.max(0, (ms - overlapStart) / span));
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

interface VideoLayer {
  el: HTMLVideoElement | HTMLImageElement;
  naturalW: number;
  naturalH: number;
  transform: Transform;
  alpha: number;
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
  // Keyed by timeline item id (which of possibly two simultaneously-active
  // items is "already playing", for the play-vs-reseek decision below) —
  // the underlying <video>/<audio> elements themselves are still keyed by
  // asset id, so two simultaneously-active items that happen to share the
  // same source asset will fight over one element. Not handled — a rare
  // edge case (transitioning a clip into another copy of itself).
  const activeVideoItemIdsRef = useRef(new Set<string>());
  const activeAudioItemIdsRef = useRef(new Set<string>());
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
    activeVideoItemIdsRef.current = new Set();
  }

  function pauseAllAudio() {
    audioElsRef.current.forEach((el) => el.pause());
    activeAudioItemIdsRef.current = new Set();
  }

  // Drives one video/audio element's seek+play state, shared by the video
  // and audio branches of render(). `wasActive` distinguishes "already
  // playing, only correct drift" from "just became active, do a hard seek".
  function driveElement(el: HTMLVideoElement | HTMLAudioElement, targetTimeS: number, wasActive: boolean) {
    if (playingRef.current) {
      if (!wasActive) {
        el.currentTime = targetTimeS;
        el.play().catch(() => undefined);
      } else if (Math.abs(el.currentTime - targetTimeS) > DRIFT_CORRECTION_S) {
        el.currentTime = targetTimeS;
      }
    } else {
      el.pause();
      // Guard against a no-op reassignment re-triggering 'seeked' in a loop.
      if (Math.abs(el.currentTime - targetTimeS) > 0.01) el.currentTime = targetTimeS;
    }
  }

  function drawFrame(layers: VideoLayer[], textItems: TextTimelineItem[]) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Layers are already in outgoing-then-incoming order — compositing the
    // incoming layer over the outgoing one with globalAlpha=t produces the
    // same result as a true linear crossfade for opaque video frames.
    for (const layer of layers) {
      if (!layer.naturalW || !layer.naturalH) continue;
      const fitScale = Math.min(canvas.width / layer.naturalW, canvas.height / layer.naturalH);
      const drawW = layer.naturalW * fitScale * layer.transform.scale;
      const drawH = layer.naturalH * fitScale * layer.transform.scale;

      ctx.save();
      ctx.globalAlpha = layer.transform.opacity * layer.alpha;
      ctx.translate(canvas.width / 2 + layer.transform.x, canvas.height / 2 + layer.transform.y);
      ctx.rotate((layer.transform.rotation * Math.PI) / 180);
      ctx.drawImage(layer.el, -drawW / 2, -drawH / 2, drawW, drawH);
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
    const videoItems = activeMediaItems(videoTrack, ms);
    const audioItems = activeMediaItems(audioTrack, ms);
    const textItems = activeTextItems(currentScene, ms);

    const videoLayers: VideoLayer[] = [];
    const activeVideoAssetIds = new Set<string>();

    videoItems.forEach((item, idx) => {
      const asset = currentMediaById.get(item.mediaAssetId);
      if (!asset?.previewUrl) return;

      let alpha = 1;
      if (videoItems.length === 2) {
        const [outgoing, incoming] = videoItems;
        const t = transitionProgress(outgoing, incoming, ms);
        if (incoming.transitionIn === "fade") {
          alpha = idx === 0 ? 1 : t;
        } else {
          // Non-fade styles (wipe/slide) aren't blended in preview —
          // approximated as a hard cut at the overlap's midpoint. Export
          // always renders the real transition regardless of style; see
          // the README's "Transitions" section.
          const showIncoming = t >= 0.5;
          if ((idx === 0 && showIncoming) || (idx === 1 && !showIncoming)) return;
        }
      }

      if (asset.kind === "VIDEO") {
        const el = getVideoEl(asset);
        activeVideoAssetIds.add(asset.id);
        const targetTime = (ms - item.startMs + item.trimInMs) / 1000;
        driveElement(el, targetTime, activeVideoItemIdsRef.current.has(item.id));
        videoLayers.push({ el, naturalW: el.videoWidth, naturalH: el.videoHeight, transform: item.transform, alpha });
      } else if (asset.kind === "IMAGE") {
        const el = getImageEl(asset);
        videoLayers.push({ el, naturalW: el.naturalWidth, naturalH: el.naturalHeight, transform: item.transform, alpha });
      }
    });

    videoElsRef.current.forEach((el, assetId) => {
      if (!activeVideoAssetIds.has(assetId)) el.pause();
    });
    activeVideoItemIdsRef.current = new Set(videoItems.map((i) => i.id));

    const activeAudioAssetIds = new Set<string>();
    audioItems.forEach((item, idx) => {
      const asset = currentMediaById.get(item.mediaAssetId);
      if (asset?.kind !== "AUDIO" || !asset.previewUrl) return;
      const el = getAudioEl(asset);
      activeAudioAssetIds.add(asset.id);
      el.muted = audioTrack?.muted ?? false;

      // A genuine volume crossfade (not just an approximation) — audio
      // elements support setting .volume directly, no Web Audio API needed.
      let volume = 1;
      if (audioItems.length === 2) {
        const t = transitionProgress(audioItems[0], audioItems[1], ms);
        volume = idx === 0 ? 1 - t : t;
      }
      el.volume = volume;

      const targetTime = (ms - item.startMs + item.trimInMs) / 1000;
      driveElement(el, targetTime, activeAudioItemIdsRef.current.has(item.id));
    });

    audioElsRef.current.forEach((el, assetId) => {
      if (!activeAudioAssetIds.has(assetId)) el.pause();
    });
    activeAudioItemIdsRef.current = new Set(audioItems.map((i) => i.id));

    drawFrame(videoLayers, textItems);
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

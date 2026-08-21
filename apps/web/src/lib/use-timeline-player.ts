"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaAsset } from "./projects-api";
import type { MediaClip } from "./composition-api";

export interface ClipLayoutEntry {
  clip: MediaClip;
  asset: MediaAsset | undefined;
  startMs: number;
  durationMs: number;
}

const EPSILON_MS = 30;

// Drives a single <video> element through the editor's one managed video
// track so playback looks continuous across clip (and source-file)
// boundaries. The real export pipeline composites full multitrack —
// overlays, a separate audio mix — (see merge-ffmpeg.util.ts on the
// backend); this preview player intentionally hasn't grown that same
// real-time compositing yet, since the editor UI itself is still
// single-track for this phase.
export function useTimelinePlayer(layout: ClipLayoutEntry[], totalDurationMs: number) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const activeIndexRef = useRef(-1);
  const pendingSeekRef = useRef(false);
  const layoutRef = useRef(layout);
  const totalRef = useRef(totalDurationMs);
  useEffect(() => {
    layoutRef.current = layout;
    totalRef.current = totalDurationMs;
  }, [layout, totalDurationMs]);

  const findIndexAt = useCallback((ms: number): number => {
    const arr = layoutRef.current;
    if (arr.length === 0) return -1;
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (ms < entry.startMs + entry.durationMs - EPSILON_MS || i === arr.length - 1) return i;
    }
    return arr.length - 1;
  }, []);

  const applyClipAV = useCallback((video: HTMLVideoElement, clip: MediaClip) => {
    video.muted = clip.muted;
    video.volume = clip.muted ? 0 : clip.volume;
  }, []);

  // Loads (if needed) and seeks the underlying <video> element to the point
  // in `entry`'s source file that corresponds to `localOffsetMs` into the
  // clip's own playable span, optionally resuming playback once ready.
  const loadEntry = useCallback(
    (index: number, localOffsetMs: number, autoplay: boolean) => {
      const entry = layoutRef.current[index];
      const video = videoRef.current;
      if (!entry?.asset?.previewUrl || !video) return;

      activeIndexRef.current = index;
      const targetSrcSeconds = (entry.clip.trimInMs + localOffsetMs) / 1000;
      applyClipAV(video, entry.clip);

      if (video.src !== entry.asset.previewUrl) {
        pendingSeekRef.current = true;
        setBuffering(true);
        video.src = entry.asset.previewUrl;

        const onReady = () => {
          video.currentTime = targetSrcSeconds;
          pendingSeekRef.current = false;
          setBuffering(false);
          if (autoplay) video.play().catch(() => setPlaying(false));
          video.removeEventListener("loadedmetadata", onReady);
        };
        video.addEventListener("loadedmetadata", onReady);
        video.load();
      } else {
        video.currentTime = targetSrcSeconds;
        if (autoplay) video.play().catch(() => setPlaying(false));
      }
    },
    [applyClipAV],
  );

  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(ms, totalRef.current));
      const index = findIndexAt(clamped);
      setPlayheadMs(clamped);
      if (index === -1) return;
      const entry = layoutRef.current[index];
      loadEntry(index, clamped - entry.startMs, playing);
    },
    [findIndexAt, loadEntry, playing],
  );

  const play = useCallback(() => {
    if (layoutRef.current.length === 0) return;
    // Restart from the top once playback has run off the end.
    const startMs = playheadMs >= totalRef.current - EPSILON_MS ? 0 : playheadMs;
    const index = findIndexAt(startMs);
    if (index === -1) return;
    setPlaying(true);
    if (index !== activeIndexRef.current) {
      loadEntry(index, startMs - layoutRef.current[index].startMs, true);
    } else {
      videoRef.current?.play().catch(() => setPlaying(false));
    }
    if (startMs !== playheadMs) setPlayheadMs(startMs);
  }, [findIndexAt, loadEntry, playheadMs]);

  const pause = useCallback(() => {
    setPlaying(false);
    videoRef.current?.pause();
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, play, pause]);

  // Advances the timeline forward by one video frame's worth of time —
  // "prev/next frame" in the spec. fps defaults to a typical 30 when the
  // project's own rate isn't passed in.
  const stepFrame = useCallback(
    (direction: 1 | -1, fps = 30) => {
      pause();
      seekTo(playheadMs + direction * (1000 / fps));
    },
    [pause, seekTo, playheadMs],
  );

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    const index = activeIndexRef.current;
    if (!video || index === -1 || pendingSeekRef.current) return;
    const entry = layoutRef.current[index];
    if (!entry) return;

    const localMs = video.currentTime * 1000 - entry.clip.trimInMs;
    const newPlayheadMs = entry.startMs + localMs;

    if (localMs >= entry.durationMs - EPSILON_MS) {
      const nextIndex = index + 1;
      if (nextIndex < layoutRef.current.length) {
        loadEntry(nextIndex, 0, true);
        setPlayheadMs(layoutRef.current[nextIndex].startMs);
      } else {
        video.pause();
        setPlaying(false);
        setPlayheadMs(totalRef.current);
      }
      return;
    }

    setPlayheadMs(newPlayheadMs);
  }, [loadEntry]);

  const handleEnded = useCallback(() => {
    const index = activeIndexRef.current;
    const nextIndex = index + 1;
    if (nextIndex < layoutRef.current.length) {
      loadEntry(nextIndex, 0, true);
      setPlayheadMs(layoutRef.current[nextIndex].startMs);
    } else {
      setPlaying(false);
      setPlayheadMs(totalRef.current);
    }
  }, [loadEntry]);

  // If the timeline changes shape underneath an active clip (trim/split/
  // delete/reorder) while paused, keep the video's displayed frame in sync
  // rather than showing a stale one.
  useEffect(() => {
    if (playing) return;
    const index = findIndexAt(playheadMs);
    if (index === -1) return;
    const entry = layoutRef.current[index];
    loadEntry(index, Math.max(0, playheadMs - entry.startMs), false);
    // Only re-sync when the layout identity changes, not on every playhead tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return {
    videoRef,
    playheadMs,
    playing,
    buffering,
    play,
    pause,
    togglePlay,
    seekTo,
    stepFrame,
    handleTimeUpdate,
    handleEnded,
  };
}

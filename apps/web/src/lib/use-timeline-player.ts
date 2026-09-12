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
// How often the playhead advances while crossing a gap. ~60fps, matching
// how smoothly `timeupdate` moves it during a clip.
const GAP_TICK_MS = 16;

// Drives a single <video> element through the editor's one managed video
// track so playback looks continuous across clip (and source-file)
// boundaries.
//
// GAPS ARE FIRST-CLASS HERE. The timeline permits them deliberately —
// Delete clip leaves one on purpose, and a clip can be dragged anywhere —
// and the export renders them as black. This player used to assume clips
// were packed end to end, which caused three separate bugs: scrubbing into
// a gap computed a NEGATIVE offset into the following clip (showing that
// clip's first frame instead of black), playback skipped over gaps that the
// exported file plays through, and the playhead stopped advancing while
// inside one. Preview and export have to agree, so a gap is now played
// through in real time, showing black.
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function useTimelinePlayer(layout: ClipLayoutEntry[], totalDurationMs: number) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  // True while the playhead sits between clips. The preview paints black
  // over the stale video frame so the screen matches the export.
  const [inGap, setInGap] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [playbackRate, setPlaybackRateState] = useState(1);

  const playbackRateRef = useRef(1);
  const activeIndexRef = useRef(-1);
  const pendingSeekRef = useRef(false);
  const layoutRef = useRef(layout);
  const totalRef = useRef(totalDurationMs);
  const playheadRef = useRef(0);
  // Intent to play, which has to survive a gap: while crossing one the
  // <video> really is paused, so reading "am I playing" off the element
  // alone would report stopped mid-playback and strand the transport.
  const wantsPlayRef = useRef(false);
  const gapTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    layoutRef.current = layout;
    totalRef.current = totalDurationMs;
  }, [layout, totalDurationMs]);
  useEffect(() => {
    playheadRef.current = playheadMs;
  }, [playheadMs]);

  /** Index of the clip covering `ms`, or -1 when `ms` is in a gap or past the end. */
  const findIndexAt = useCallback((ms: number): number => {
    return layoutRef.current.findIndex((e) => ms >= e.startMs - EPSILON_MS && ms < e.startMs + e.durationMs - EPSILON_MS);
  }, []);

  /** The first clip starting after `ms` — i.e. where a gap ends. */
  const findNextIndexAfter = useCallback((ms: number): number => {
    return layoutRef.current.findIndex((e) => e.startMs > ms - EPSILON_MS);
  }, []);

  const clearGapTimer = useCallback(() => {
    if (gapTimerRef.current) {
      clearInterval(gapTimerRef.current);
      gapTimerRef.current = null;
    }
  }, []);

  const applyClipAV = useCallback((video: HTMLVideoElement, clip: MediaClip) => {
    video.muted = clip.muted;
    // The <video> element clamps volume to [0,1]; clip volume goes to 2 for
    // boosting, which the export pipeline honors via ffmpeg's volume filter.
    video.volume = clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume));
    video.playbackRate = playbackRateRef.current;
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    playbackRateRef.current = rate;
    setPlaybackRateState(rate);
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, []);

  const preloaderRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (typeof document !== "undefined") {
      const p = document.createElement("video");
      p.preload = "auto";
      p.muted = true;
      preloaderRef.current = p;
    }
    return () => {
      if (preloaderRef.current) {
        preloaderRef.current.src = "";
        preloaderRef.current = null;
      }
    };
  }, []);

  const preloadNextClip = useCallback((currentIndex: number) => {
    const nextEntry = layoutRef.current[currentIndex + 1];
    if (nextEntry?.asset?.previewUrl && preloaderRef.current) {
      if (preloaderRef.current.src !== nextEntry.asset.previewUrl) {
        preloaderRef.current.src = nextEntry.asset.previewUrl;
        preloaderRef.current.load();
      }
    }
  }, []);

  const loadEntry = useCallback(
    (index: number, localOffsetMs: number, autoplay: boolean) => {
      const entry = layoutRef.current[index];
      const video = videoRef.current;
      if (!entry?.asset?.previewUrl || !video) return;

      clearGapTimer();
      setInGap(false);
      activeIndexRef.current = index;
      preloadNextClip(index);

      // Never seek outside the clip's own span: a caller landing slightly
      // early (rounding, or a gap boundary) would otherwise ask the element
      // for a negative source time.
      const safeOffset = Math.max(0, Math.min(localOffsetMs, entry.durationMs));
      const targetSrcSeconds = (entry.clip.trimInMs + safeOffset) / 1000;
      applyClipAV(video, entry.clip);

      if (video.src !== entry.asset.previewUrl) {
        pendingSeekRef.current = true;
        setBuffering(true);
        setMediaError(null);
        video.src = entry.asset.previewUrl;

        const cleanup = () => {
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("error", onError);
        };
        const onReady = () => {
          video.currentTime = targetSrcSeconds;
          // Assigning .src resets playbackRate to 1 — restore the chosen
          // speed, or it silently snaps back at every clip boundary.
          video.playbackRate = playbackRateRef.current;
          pendingSeekRef.current = false;
          setBuffering(false);
          if (autoplay) video.play().catch(() => undefined);
          cleanup();
        };
        // Without this, a source that fails to load (an expired presigned
        // URL, a dropped connection) leaves pendingSeek stuck true forever
        // — which disables every timeupdate, so the playhead freezes and
        // the transport looks dead with nothing on screen explaining why.
        const onError = () => {
          pendingSeekRef.current = false;
          setBuffering(false);
          clearGapTimer();
          wantsPlayRef.current = false;
          setPlaying(false);
          setMediaError("Couldn't load this clip's video. Reload the page to refresh the media links.");
          cleanup();
        };
        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("error", onError);
        video.load();
      } else {
        video.currentTime = targetSrcSeconds;
        if (autoplay) video.play().catch(() => undefined);
      }
    },
    [applyClipAV, clearGapTimer, preloadNextClip],
  );

  // Runs the playhead through a gap in real time, then picks the next clip
  // up. The exported file plays black here, so the preview does too rather
  // than skipping ahead and disagreeing with it.
  const startGapPlayback = useCallback(() => {
    clearGapTimer();
    videoRef.current?.pause();
    setInGap(true);

    let last = performance.now();
    gapTimerRef.current = setInterval(() => {
      const now = performance.now();
      const advanced = (now - last) * playbackRateRef.current;
      last = now;
      const next = playheadRef.current + advanced;

      if (next >= totalRef.current) {
        clearGapTimer();
        wantsPlayRef.current = false;
        setPlaying(false);
        setInGap(false);
        setPlayheadMs(totalRef.current);
        playheadRef.current = totalRef.current;
        return;
      }

      const index = findIndexAt(next);
      if (index !== -1) {
        // Reached the next clip — hand playback back to the element.
        const start = layoutRef.current[index]!.startMs;
        setPlayheadMs(start);
        playheadRef.current = start;
        loadEntry(index, 0, wantsPlayRef.current);
        return;
      }
      setPlayheadMs(next);
      playheadRef.current = next;
    }, GAP_TICK_MS);
  }, [clearGapTimer, findIndexAt, loadEntry]);

  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(ms, totalRef.current));
      setPlayheadMs(clamped);
      playheadRef.current = clamped;

      const index = findIndexAt(clamped);
      if (index === -1) {
        // In a gap (or past the last clip): show black, and keep running
        // through it if playback was under way.
        activeIndexRef.current = -1;
        clearGapTimer();
        videoRef.current?.pause();
        setInGap(true);
        if (wantsPlayRef.current) startGapPlayback();
        return;
      }
      loadEntry(index, clamped - layoutRef.current[index]!.startMs, wantsPlayRef.current);
    },
    [clearGapTimer, findIndexAt, loadEntry, startGapPlayback],
  );

  const play = useCallback(() => {
    if (layoutRef.current.length === 0) return;
    // Restart from the top once playback has run off the end.
    const startMs = playheadRef.current >= totalRef.current - EPSILON_MS ? 0 : playheadRef.current;
    wantsPlayRef.current = true;
    setPlaying(true);
    if (startMs !== playheadRef.current) {
      setPlayheadMs(startMs);
      playheadRef.current = startMs;
    }

    const index = findIndexAt(startMs);
    if (index === -1) {
      startGapPlayback();
      return;
    }
    if (index !== activeIndexRef.current) {
      loadEntry(index, startMs - layoutRef.current[index]!.startMs, true);
    } else {
      videoRef.current?.play().catch(() => undefined);
    }
  }, [findIndexAt, loadEntry, startGapPlayback]);

  const pause = useCallback(() => {
    wantsPlayRef.current = false;
    clearGapTimer();
    setInGap(findIndexAt(playheadRef.current) === -1 && layoutRef.current.length > 0);
    setPlaying(false);
    videoRef.current?.pause();
  }, [clearGapTimer, findIndexAt]);

  const togglePlay = useCallback(() => {
    // Driven by intent, not by the element: while crossing a gap the
    // element is paused on purpose, and keying off it would make the
    // button restart playback instead of stopping it.
    if (wantsPlayRef.current) pause();
    else play();
  }, [pause, play]);

  // Mirror the element's real play/pause/ended events so React state can't
  // drift from the DOM — browsers can interrupt an in-flight play() promise
  // and leave a manually-tracked flag claiming "playing" while the element
  // is actually paused, which makes the button a no-op.
  //
  // The gap guard matters: crossing a gap pauses the element deliberately,
  // and without it that pause would be misread as the user stopping.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => {
      wantsPlayRef.current = true;
      setPlaying(true);
    };
    const onPause = () => {
      if (gapTimerRef.current) return;
      wantsPlayRef.current = false;
      setPlaying(false);
    };
    const onEnded = () => {
      if (gapTimerRef.current) return;
      setPlaying(false);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, []);

  useEffect(() => clearGapTimer, [clearGapTimer]);

  const stepFrame = useCallback(
    (direction: 1 | -1, fps = 30) => {
      pause();
      seekTo(playheadRef.current + direction * (1000 / fps));
    },
    [pause, seekTo],
  );

  // Called when the current clip runs out: either the next one starts
  // immediately, or there's a gap to cross, or that was the end.
  const advancePastClip = useCallback(() => {
    const entry = layoutRef.current[activeIndexRef.current];
    const endMs = entry ? entry.startMs + entry.durationMs : playheadRef.current;

    const nextIndex = findNextIndexAfter(endMs);
    if (nextIndex === -1) {
      clearGapTimer();
      wantsPlayRef.current = false;
      setPlaying(false);
      setPlayheadMs(totalRef.current);
      playheadRef.current = totalRef.current;
      return;
    }

    const nextStart = layoutRef.current[nextIndex]!.startMs;
    if (nextStart - endMs <= EPSILON_MS) {
      setPlayheadMs(nextStart);
      playheadRef.current = nextStart;
      loadEntry(nextIndex, 0, wantsPlayRef.current);
      return;
    }

    // A real gap: hold at this clip's end, then play through it as black.
    setPlayheadMs(endMs);
    playheadRef.current = endMs;
    activeIndexRef.current = -1;
    if (wantsPlayRef.current) {
      startGapPlayback();
    } else {
      videoRef.current?.pause();
      setInGap(true);
    }
  }, [clearGapTimer, findNextIndexAfter, loadEntry, startGapPlayback]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    const index = activeIndexRef.current;
    if (!video || index === -1 || pendingSeekRef.current) return;
    const entry = layoutRef.current[index];
    if (!entry) return;

    const localMs = video.currentTime * 1000 - entry.clip.trimInMs;
    if (localMs >= entry.durationMs - EPSILON_MS) {
      advancePastClip();
      return;
    }
    const next = entry.startMs + localMs;
    setPlayheadMs(next);
    playheadRef.current = next;
  }, [advancePastClip]);

  const handleEnded = useCallback(() => {
    if (activeIndexRef.current === -1) return;
    advancePastClip();
  }, [advancePastClip]);

  // If the timeline changes shape underneath an active clip (trim/split/
  // delete/reorder/move) while paused, keep the displayed frame in sync
  // rather than showing a stale one.
  useEffect(() => {
    if (wantsPlayRef.current) return;
    const index = findIndexAt(playheadRef.current);
    if (index === -1) {
      activeIndexRef.current = -1;
      setInGap(layoutRef.current.length > 0);
      return;
    }
    const entry = layoutRef.current[index]!;
    loadEntry(index, Math.max(0, playheadRef.current - entry.startMs), false);
    // Only re-sync when the layout identity changes, not on every playhead tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // "Stop" in the editor sense: halt playback AND return to the start, as
  // distinct from Pause which holds position.
  const stop = useCallback(() => {
    wantsPlayRef.current = false;
    clearGapTimer();
    setPlaying(false);
    videoRef.current?.pause();
    seekTo(0);
  }, [clearGapTimer, seekTo]);

  return {
    videoRef,
    playheadMs,
    playing,
    buffering,
    inGap,
    mediaError,
    playbackRate,
    setPlaybackRate,
    play,
    pause,
    stop,
    togglePlay,
    seekTo,
    stepFrame,
    handleTimeUpdate,
    handleEnded,
  };
}

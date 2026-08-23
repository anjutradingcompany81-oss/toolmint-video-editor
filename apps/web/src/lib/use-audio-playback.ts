"use client";

import { useEffect, useRef } from "react";
import type { MediaAsset } from "./projects-api";
import type { MediaClip } from "./composition-api";

// Plays the audio-track clips (uploaded music/narration and the generated
// voice over) alongside the preview's <video>.
//
// The preview drives one <video> element, which carries only that clip's
// own embedded sound. Anything on an audio track was therefore silent
// while editing and only appeared once exported — so there was no way to
// judge timing against the picture, which is the entire reason for putting
// audio on a timeline.
//
// The video stays the clock. These elements follow the playhead rather
// than running free, because two media elements started together drift
// apart within seconds and there is no way to slave one to another in the
// browser.

// Only correct when we are further out than this. Seeking an <audio>
// element interrupts playback audibly, so chasing every few milliseconds
// of jitter would stutter far worse than the drift it fixes.
const DRIFT_TOLERANCE_MS = 180;

interface AudioPlaybackOptions {
  clips: MediaClip[];
  assetById: Map<string, MediaAsset>;
  playheadMs: number;
  playing: boolean;
  playbackRate: number;
  /** Muted while scrubbing/seeking, where audio bursts are just noise. */
  enabled?: boolean;
}

export function useAudioPlayback({ clips, assetById, playheadMs, playing, playbackRate, enabled = true }: AudioPlaybackOptions) {
  // One element per clip, created on first use and reused after that.
  const elementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Drop elements for clips that no longer exist, so deleting a clip stops
  // its sound and doesn't leak a decoder for the life of the page.
  useEffect(() => {
    const live = new Set(clips.map((c) => c.id));
    for (const [clipId, el] of elementsRef.current) {
      if (!live.has(clipId)) {
        el.pause();
        el.src = "";
        elementsRef.current.delete(clipId);
      }
    }
  }, [clips]);

  useEffect(() => {
    const elements = elementsRef.current;
    return () => {
      for (const el of elements.values()) {
        el.pause();
        el.src = "";
      }
      elements.clear();
    };
  }, []);

  useEffect(() => {
    for (const clip of clips) {
      const asset = assetById.get(clip.mediaAssetId);
      if (!asset?.previewUrl) continue;

      const active = enabled && playheadMs >= clip.startMs && playheadMs < clip.startMs + clip.durationMs;
      let el = elementsRef.current.get(clip.id);

      if (!active) {
        if (el && !el.paused) el.pause();
        continue;
      }

      if (!el) {
        el = new Audio(asset.previewUrl);
        el.preload = "auto";
        elementsRef.current.set(clip.id, el);
      } else if (el.src !== asset.previewUrl) {
        // The presigned URL is refreshed periodically; pick up the new one
        // rather than failing silently once the old one expires.
        el.src = asset.previewUrl;
      }

      el.muted = clip.muted;
      el.volume = clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume));
      el.playbackRate = playbackRate;

      const targetSeconds = (clip.trimInMs + (playheadMs - clip.startMs)) / 1000;
      if (Math.abs(el.currentTime - targetSeconds) * 1000 > DRIFT_TOLERANCE_MS) {
        el.currentTime = Math.max(0, targetSeconds);
      }

      if (playing && el.paused) {
        // Rejected when the browser blocks autoplay before any user
        // gesture; the next real play click succeeds, so this is not worth
        // surfacing as an error.
        void el.play().catch(() => undefined);
      } else if (!playing && !el.paused) {
        el.pause();
      }
    }
  }, [clips, assetById, playheadMs, playing, playbackRate, enabled]);
}

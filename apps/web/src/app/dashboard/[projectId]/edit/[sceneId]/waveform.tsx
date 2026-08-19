"use client";

import { useMemo } from "react";

const VIEWBOX_W = 200;
const VIEWBOX_H = 32;
const MID = VIEWBOX_H / 2;

interface WaveformProps {
  peaks: number[];
  // The clip on the timeline usually only plays back a trimmed slice of the
  // source — peaks always cover the *whole* source at a fixed 200 buckets,
  // so this slices to just the visible portion when the source length is
  // known. Falls back to showing the full waveform (slightly inaccurate for
  // a trimmed clip, but still informative) when it isn't.
  sourceDurationMs: number | null;
  trimInMs: number;
  durationMs: number;
  // A clip playing faster/slower than 100% consumes durationMs*speedRate of
  // source time, not durationMs — matters here because the visible slice of
  // the source waveform has to match what's actually being played back.
  speedPercent?: number;
  className?: string;
}

export default function Waveform({ peaks, sourceDurationMs, trimInMs, durationMs, speedPercent = 100, className }: WaveformProps) {
  const path = useMemo(() => {
    const bucketCount = peaks.length / 2;
    let visible = peaks;
    const sourceSpanMs = durationMs * (speedPercent / 100);

    if (sourceDurationMs && sourceDurationMs > 0) {
      const bucketMs = sourceDurationMs / bucketCount;
      const startBucket = Math.max(0, Math.floor(trimInMs / bucketMs));
      const endBucket = Math.min(bucketCount, Math.ceil((trimInMs + sourceSpanMs) / bucketMs));
      visible = peaks.slice(startBucket * 2, Math.max(startBucket * 2 + 2, endBucket * 2));
    }

    const n = visible.length / 2;
    if (n < 1) return "";

    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1 || 1)) * VIEWBOX_W;
      const min = visible[i * 2];
      const max = visible[i * 2 + 1];
      top.push(`${x.toFixed(1)},${(MID - max * MID).toFixed(1)}`);
      bottom.push(`${x.toFixed(1)},${(MID - min * MID).toFixed(1)}`);
    }
    return `M ${top.join(" L ")} L ${bottom.reverse().join(" L ")} Z`;
  }, [peaks, sourceDurationMs, trimInMs, durationMs, speedPercent]);

  if (!path) return null;

  return (
    <svg viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`} preserveAspectRatio="none" className={className}>
      <path d={path} fill="currentColor" fillOpacity={0.55} stroke="none" />
    </svg>
  );
}

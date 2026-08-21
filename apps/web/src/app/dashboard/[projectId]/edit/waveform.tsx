"use client";

import { useMemo } from "react";

const VIEWBOX_W = 200;
const VIEWBOX_H = 32;
const MID = VIEWBOX_H / 2;

interface WaveformProps {
  peaks: number[];
  // Peaks always cover the *whole* source at a fixed 200 buckets — this
  // slices to just the trimmed slice a clip actually plays back.
  sourceDurationMs: number | null;
  trimInMs: number;
  durationMs: number;
  className?: string;
}

export default function Waveform({ peaks, sourceDurationMs, trimInMs, durationMs, className }: WaveformProps) {
  const path = useMemo(() => {
    const bucketCount = peaks.length / 2;
    let visible = peaks;

    if (sourceDurationMs && sourceDurationMs > 0) {
      const bucketMs = sourceDurationMs / bucketCount;
      const startBucket = Math.max(0, Math.floor(trimInMs / bucketMs));
      const endBucket = Math.min(bucketCount, Math.ceil((trimInMs + durationMs) / bucketMs));
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
  }, [peaks, sourceDurationMs, trimInMs, durationMs]);

  if (!path) return null;

  return (
    <svg viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`} preserveAspectRatio="none" className={className}>
      <path d={path} fill="currentColor" fillOpacity={0.55} stroke="none" />
    </svg>
  );
}

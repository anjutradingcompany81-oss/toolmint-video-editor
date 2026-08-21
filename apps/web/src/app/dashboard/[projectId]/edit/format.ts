// Shared formatting helpers for the editor — timecodes, file sizes,
// resolution strings. Kept tiny and dependency-free.

export function formatTimecode(ms: number, withCentis = false): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const cs = Math.floor((clamped % 1000) / 10);

  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const base = h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  return withCentis ? `${base}.${String(cs).padStart(2, "0")}` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatResolution(width: number | null, height: number | null): string {
  if (!width || !height) return "Unknown resolution";
  return `${width}×${height}`;
}

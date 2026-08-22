"use client";

import { useState } from "react";
import { newSubtitleCue, type SubtitleCue, type SubtitleStyle } from "@/lib/composition-api";
import { listVoiceScans, getVoiceScanTranscript } from "@/lib/voice-scan-api";
import { ApiError, API_BASE_URL, getAccessToken } from "@/lib/api-client";
import { TrashIcon } from "@/components/icons";
import { formatTimecode } from "./format";

interface SubtitlesPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  subtitles: SubtitleCue[];
  subtitleStyle: SubtitleStyle;
  onChange: (next: SubtitleCue[], nextStyle?: SubtitleStyle) => void;
  onSeek: (ms: number) => void;
}

export default function SubtitlesPanel({ open, onClose, projectId, subtitles, subtitleStyle, onChange, onSeek }: SubtitlesPanelProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Captions come from the transcript the AI Voice Correction scan already
  // produced — the audio has been transcribed with timestamps at that
  // point, so generating them again here would be wasted work.
  async function generateFromTranscript() {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const scans = await listVoiceScans(projectId);
      const completed = scans.filter((s) => s.status === "COMPLETED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!completed) {
        setError("No transcript yet. Run AI Voice Correction first — it transcribes the audio, and captions are built from that transcript.");
        return;
      }
      const lines = await getVoiceScanTranscript(projectId, completed.id);
      if (lines.length === 0) {
        setError("That scan found no speech to caption.");
        return;
      }
      onChange(lines.map((l) => newSubtitleCue(l.startMs, l.endMs, l.text)));
      setNotice(`Generated ${lines.length} caption${lines.length === 1 ? "" : "s"} from the latest transcript.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't build captions from the transcript.");
    } finally {
      setGenerating(false);
    }
  }

  function editCue(id: string, text: string) {
    onChange(subtitles.map((c) => (c.id === id ? { ...c, text } : c)));
  }

  function removeCue(id: string) {
    onChange(subtitles.filter((c) => c.id !== id));
  }

  function setStyle(patch: Partial<SubtitleStyle>) {
    onChange(subtitles, { ...subtitleStyle, ...patch });
  }

  // These endpoints sit behind the JWT guard, so a plain <a href> would
  // 401 — and a token in the URL would leak into history/logs. Fetch with
  // the Authorization header, then hand the browser a blob to save.
  async function download(format: "srt" | "vtt") {
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/projects/${projectId}/composition/subtitles.${format}`, {
        headers: { Authorization: `Bearer ${getAccessToken() ?? ""}` },
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `subtitles.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? `Couldn't download the ${format.toUpperCase()} file: ${err.message}` : "Download failed.");
    }
  }

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[420px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Subtitles</h2>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <button
            onClick={generateFromTranscript}
            disabled={generating}
            className="rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink hover:bg-brand/90 disabled:opacity-40"
          >
            {generating ? "Reading transcript…" : subtitles.length > 0 ? "Regenerate from transcript" : "Generate from transcript"}
          </button>

          {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          {notice && <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}

          {subtitles.length > 0 && (
            <>
              <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-panel/60 p-3">
                <p className="text-xs uppercase tracking-wide text-ink-muted">Style</p>

                <label className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                  Font size
                  <input
                    type="number"
                    min={8}
                    max={200}
                    value={subtitleStyle.fontSizePx}
                    onChange={(e) => setStyle({ fontSizePx: Math.min(200, Math.max(8, Number(e.target.value) || 24)) })}
                    className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                  Position
                  <select
                    value={subtitleStyle.position}
                    onChange={(e) => setStyle({ position: e.target.value as SubtitleStyle["position"] })}
                    className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand [color-scheme:dark]"
                  >
                    <option value="BOTTOM">Bottom</option>
                    <option value="TOP">Top</option>
                  </select>
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                  Text colour
                  <input
                    type="color"
                    value={subtitleStyle.colorHex}
                    onChange={(e) => setStyle({ colorHex: e.target.value.toUpperCase() })}
                    className="h-7 w-12 cursor-pointer rounded border border-line bg-surface"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-ink-muted">
                  Outline colour
                  <input
                    type="color"
                    value={subtitleStyle.outlineHex}
                    onChange={(e) => setStyle({ outlineHex: e.target.value.toUpperCase() })}
                    className="h-7 w-12 cursor-pointer rounded border border-line bg-surface"
                  />
                </label>

                <label className="flex items-start gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={subtitleStyle.burnIn}
                    onChange={(e) => setStyle({ burnIn: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-neutral-300"
                  />
                  <span>
                    Burn captions into the exported video
                    <span className="block text-ink-muted">
                      Off by default — the .srt/.vtt files below work without changing the picture.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex gap-2">
                <button onClick={() => download("srt")} className="flex-1 rounded-md border border-line py-1.5 text-xs text-ink hover:border-brand">
                  Export .SRT
                </button>
                <button onClick={() => download("vtt")} className="flex-1 rounded-md border border-line py-1.5 text-xs text-ink hover:border-brand">
                  Export .VTT
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs uppercase tracking-wide text-ink-muted">
                  {subtitles.length} caption{subtitles.length === 1 ? "" : "s"}
                </p>
                {subtitles.map((cue) => (
                  <div key={cue.id} className="flex items-start gap-2 rounded-md border border-line bg-panel px-2 py-1.5">
                    <button
                      onClick={() => onSeek(cue.startMs)}
                      title="Jump here"
                      className="shrink-0 pt-1 font-mono text-[10px] tabular-nums text-ink-muted hover:text-ink"
                    >
                      {formatTimecode(cue.startMs, true)}
                    </button>
                    <textarea
                      dir="auto"
                      rows={2}
                      value={cue.text}
                      onChange={(e) => editCue(cue.id, e.target.value)}
                      className="flex-1 resize-none rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-brand"
                    />
                    <button onClick={() => removeCue(cue.id)} title="Delete this caption" className="shrink-0 pt-1 text-ink-muted hover:text-danger">
                      <TrashIcon width={12} height={12} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

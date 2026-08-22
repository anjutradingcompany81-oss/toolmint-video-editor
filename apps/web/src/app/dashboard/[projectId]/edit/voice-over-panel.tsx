"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api-client";
import { listVoiceScans, getVoiceScanTranscript } from "@/lib/voice-scan-api";
import { listMedia, type MediaAsset } from "@/lib/projects-api";
import {
  ACTIVE_VOICE_OVER_STATUSES,
  cancelVoiceOverJob,
  generateVoiceOver,
  getVoiceOverJob,
  getVoiceOverProviders,
  getVoiceOverScript,
  listVoiceOverJobs,
  saveVoiceOverScript,
  type TtsProviderStatus,
  type VoiceOverJob,
  type VoiceOverLine,
} from "@/lib/voice-over-api";
import { PlusIcon, TrashIcon } from "@/components/icons";
import { formatTimecode } from "./format";

const SCRIPT_SAVE_DEBOUNCE_MS = 1200;
const JOB_POLL_MS = 2000;

interface VoiceOverPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onSeek: (ms: number) => void;
  onPlaced: (asset: MediaAsset, durationMs: number) => void;
  onRemove: () => void;
  hasVoiceOverOnTimeline: boolean;
}

function newLineId() {
  return `vol_${Math.random().toString(36).slice(2, 10)}`;
}

export default function VoiceOverPanel({
  open,
  onClose,
  projectId,
  onSeek,
  onPlaced,
  onRemove,
  hasVoiceOverOnTimeline,
}: VoiceOverPanelProps) {
  const [providers, setProviders] = useState<TtsProviderStatus[] | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [lines, setLines] = useState<VoiceOverLine[]>([]);
  const [job, setJob] = useState<VoiceOverJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Tracks whether the last generated job's audio is already on the
  // timeline, so the Apply button doesn't invite the user to add it twice.
  const [appliedJobId, setAppliedJobId] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const provider = providers?.find((p) => p.id === providerId) ?? null;
  const readyProviders = providers?.filter((p) => p.readiness === "READY") ?? [];

  // Load providers, the saved script draft, and any job still running from
  // a previous visit — closing the panel must not orphan a generation
  // that's still going.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [providerList, script, jobs] = await Promise.all([
          getVoiceOverProviders(projectId),
          getVoiceOverScript(projectId),
          listVoiceOverJobs(projectId),
        ]);
        if (cancelled) return;

        setProviders(providerList);
        setLines(script.lines);

        // Prefer the saved choice, but never select a provider that has
        // since become unusable (a key removed from the server, say).
        const savedIsUsable = script.providerId && providerList.some((p) => p.id === script.providerId && p.readiness === "READY");
        const fallback = providerList.find((p) => p.readiness === "READY") ?? providerList[0];
        setProviderId(savedIsUsable ? script.providerId! : (fallback?.id ?? ""));

        const latest = jobs[0] ?? null;
        setJob(latest);
        if (latest?.status === "COMPLETED" && hasVoiceOverOnTimeline) setAppliedJobId(latest.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't open voice over.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // Poll while a job is running. Stops as soon as it reaches a terminal
  // state so an open panel isn't a permanent request loop.
  useEffect(() => {
    if (!open || !job || !ACTIVE_VOICE_OVER_STATUSES.includes(job.status)) return;
    let cancelled = false;

    const timer = setInterval(async () => {
      try {
        const next = await getVoiceOverJob(projectId, job.id);
        if (!cancelled) setJob(next);
      } catch {
        // A single failed poll is not worth surfacing — the next tick
        // usually succeeds, and the job keeps running regardless.
      }
    }, JOB_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, job, projectId]);

  const persist = useCallback(
    (nextLines: VoiceOverLine[], nextProviderId: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // Draft saving is best-effort: a failure here must not block the
        // user from carrying on writing, and Generate sends the lines it
        // has in hand rather than relying on the draft having landed.
        saveVoiceOverScript(projectId, { providerId: nextProviderId || undefined, lines: nextLines }).catch(() => undefined);
      }, SCRIPT_SAVE_DEBOUNCE_MS);
    },
    [projectId],
  );

  useEffect(() => () => void (saveTimer.current && clearTimeout(saveTimer.current)), []);

  function updateLines(next: VoiceOverLine[]) {
    setLines(next);
    persist(next, providerId);
  }

  function chooseProvider(id: string) {
    setProviderId(id);
    // Voice ids are provider-specific, so a line pointing at the old
    // provider's voice would be rejected at generation time. Re-point
    // every line at the new provider's first voice instead of failing
    // later with a confusing "not a voice offered by..." error.
    const firstVoice = providers?.find((p) => p.id === id)?.voices[0]?.id ?? "";
    const next = lines.map((line) => ({ ...line, voiceId: firstVoice }));
    setLines(next);
    persist(next, id);
  }

  // Pulls the existing dialogue in, so "rewrite what was said" starts from
  // what was actually said rather than a blank page. Uses the transcript
  // the AI Voice Correction scan already produced.
  async function importFromTranscript() {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const scans = await listVoiceScans(projectId);
      const completed = scans.filter((s) => s.status === "COMPLETED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!completed) {
        setError("No transcript yet. Run AI Voice Correction first — it transcribes the audio, and the dialogue is imported from that transcript.");
        return;
      }
      const transcript = await getVoiceScanTranscript(projectId, completed.id);
      if (transcript.length === 0) {
        setError("That scan found no speech to import.");
        return;
      }
      const defaultVoice = provider?.voices[0]?.id ?? "";
      const next: VoiceOverLine[] = transcript.map((l) => ({
        id: newLineId(),
        startMs: l.startMs,
        text: l.text.trim(),
        voiceId: defaultVoice,
        speakerLabel: undefined,
      }));
      updateLines(next);
      setNotice(`Imported ${next.length} line(s). Edit any of them — the voice over speaks what's written here, not the original audio.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import the dialogue.");
    } finally {
      setImporting(false);
    }
  }

  function addLine() {
    const last = lines[lines.length - 1];
    updateLines([
      ...lines,
      { id: newLineId(), startMs: last ? last.startMs + 3000 : 0, text: "", voiceId: provider?.voices[0]?.id ?? "" },
    ]);
  }

  async function generate() {
    setError(null);
    setNotice(null);
    const speakable = lines.filter((l) => l.text.trim().length > 0);
    if (speakable.length === 0) {
      setError("Write at least one line of dialogue first.");
      return;
    }
    try {
      const created = await generateVoiceOver(projectId, { providerId, lines: speakable });
      setJob(created);
      setAppliedJobId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start generating the voice over.");
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      setJob(await cancelVoiceOverJob(projectId, job.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel.");
    }
  }

  // The generated file is a normal project media asset, so its real
  // duration is read back from the media list rather than guessed from the
  // line timings — a mismatch would put a clip on the timeline that is
  // shorter or longer than the audio it plays.
  async function applyToTimeline() {
    if (!job?.resultMediaAssetId) return;
    setError(null);
    try {
      const assets = await listMedia(projectId);
      const asset = assets.find((a) => a.id === job.resultMediaAssetId);
      if (!asset) {
        setError("The generated voice over is no longer in this project's media.");
        return;
      }
      if (!asset.durationMs) {
        setError("The generated voice over has no readable duration, so it can't be placed on the timeline.");
        return;
      }
      onPlaced(asset, asset.durationMs);
      setAppliedJobId(job.id);
      setNotice("Voice over added to the timeline as its own audio track. Play the preview to hear it over your video.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the voice over to the timeline.");
    }
  }

  if (!open) return null;

  const running = job !== null && ACTIVE_VOICE_OVER_STATUSES.includes(job.status);
  const timingFor = (lineId: string) => job?.lineTimings?.find((t) => t.lineId === lineId) ?? null;

  return (
    <aside className="absolute right-0 top-14 z-40 flex h-[calc(100%-3.5rem)] w-[460px] flex-col border-l border-line bg-surface-2 shadow-2xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">AI Voice Over</h2>
          <p className="text-[11px] text-ink-muted">Rewrite the dialogue and have it spoken in a new voice.</p>
        </div>
        <button onClick={onClose} className="rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-panel hover:text-ink">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <p className="text-sm text-ink-muted">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Providers — shown in full, including the ones this server
                can't run, so the missing setting is visible rather than
                the feature just being absent. */}
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel/60 p-3">
              <p className="text-xs uppercase tracking-wide text-ink-muted">Voice engine</p>
              {providers?.map((p) => {
                const ready = p.readiness === "READY";
                return (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 ${
                      providerId === p.id ? "border-brand bg-brand/10" : "border-line"
                    } ${ready ? "" : "opacity-70"}`}
                  >
                    <input
                      type="radio"
                      name="tts-provider"
                      className="mt-1"
                      checked={providerId === p.id}
                      disabled={!ready}
                      onChange={() => chooseProvider(p.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-sm text-ink">{p.label}</span>
                        {ready ? (
                          <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">Ready</span>
                        ) : (
                          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Needs setup</span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">{p.description}</span>
                      {!ready && p.requiredEnvVar && (
                        <span className="mt-1 block text-[11px] leading-snug text-warning">
                          Not available on this server: <code className="font-mono">{p.requiredEnvVar}</code> isn&apos;t set. Everything else here
                          works without it.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              {readyProviders.length === 0 && (
                <p className="text-[11px] text-danger">No voice engine is usable on this server right now.</p>
              )}
            </div>

            {/* Cloning a speaker from the footage is a real capability of
                some providers and not of others. Say which, rather than
                showing a control that can't work. */}
            <div className="rounded-lg border border-line bg-panel/40 p-3 text-[11px] leading-snug text-ink-muted">
              <p className="mb-1 font-medium text-ink">Using a voice from your own video</p>
              {provider?.supportsVoiceCloning ? (
                <p>
                  {provider.label} supports voice cloning. Clone the speaker in the ElevenLabs dashboard, and the cloned voice appears in the
                  list below.
                </p>
              ) : (
                <p>
                  The built-in engine has one fixed speaker per language and cannot imitate a specific person — that needs a cloning-capable
                  engine such as ElevenLabs. Pick from the voice library below instead.
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={importFromTranscript}
                disabled={importing}
                className="flex-1 rounded-md border border-line px-3 py-2 text-xs text-ink hover:border-brand disabled:opacity-40"
              >
                {importing ? "Reading transcript…" : "Import dialogue from transcript"}
              </button>
              <button onClick={addLine} className="flex items-center gap-1 rounded-md border border-line px-3 py-2 text-xs text-ink hover:border-brand">
                <PlusIcon width={12} height={12} /> Line
              </button>
            </div>

            {error && <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            {notice && <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}

            {lines.length === 0 && (
              <p className="rounded-md border border-line bg-panel/40 px-3 py-4 text-center text-xs text-ink-muted">
                No dialogue yet. Import it from the transcript, or add a line and write your own narration.
              </p>
            )}

            {lines.map((line, index) => {
              const timing = timingFor(line.id);
              return (
                <div key={line.id} className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-2.5">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => onSeek(line.startMs)}
                      title="Jump to this point in the video"
                      className="font-mono text-[10px] tabular-nums text-ink-muted hover:text-ink"
                    >
                      {formatTimecode(line.startMs, true)}
                    </button>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={line.startMs}
                      onChange={(e) =>
                        updateLines(lines.map((l) => (l.id === line.id ? { ...l, startMs: Math.max(0, Number(e.target.value) || 0) } : l)))
                      }
                      title="Start time in milliseconds"
                      className="w-24 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-brand"
                    />
                    <select
                      value={line.voiceId}
                      onChange={(e) => updateLines(lines.map((l) => (l.id === line.id ? { ...l, voiceId: e.target.value } : l)))}
                      className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-brand [color-scheme:dark]"
                    >
                      {(provider?.voices ?? []).map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                      {(provider?.voices ?? []).length === 0 && <option value="">No voices available</option>}
                    </select>
                    <button
                      onClick={() => updateLines(lines.filter((l) => l.id !== line.id))}
                      title="Delete this line"
                      className="shrink-0 text-ink-muted hover:text-danger"
                    >
                      <TrashIcon width={12} height={12} />
                    </button>
                  </div>

                  <textarea
                    dir="auto"
                    rows={2}
                    value={line.text}
                    placeholder={`Line ${index + 1} — what should be said here?`}
                    onChange={(e) => updateLines(lines.map((l) => (l.id === line.id ? { ...l, text: e.target.value } : l)))}
                    className="w-full resize-y rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
                  />

                  {/* How long the line actually turned out to be is only
                      known after generating it, so this appears once a job
                      has run — including when it runs into the next line. */}
                  {timing && (
                    <p className={`text-[11px] ${timing.overlapsNextByMs > 0 ? "text-warning" : "text-ink-muted"}`}>
                      Spoken length {(timing.durationMs / 1000).toFixed(1)}s, ending at {formatTimecode(timing.endMs)}
                      {timing.overlapsNextByMs > 0 &&
                        ` — runs ${(timing.overlapsNextByMs / 1000).toFixed(1)}s past the next line, so they overlap. Move the next line later or shorten this one.`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        {job && (
          <div className="mb-2 rounded-md border border-line bg-panel px-3 py-2">
            {running ? (
              <>
                <div className="flex items-center justify-between text-xs text-ink">
                  <span>{job.stageLabel ?? "Working…"}</span>
                  <span className="tabular-nums text-ink-muted">{job.progress}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${job.progress}%` }} />
                </div>
                <button onClick={cancel} className="mt-2 text-[11px] text-ink-muted underline hover:text-ink">
                  Cancel
                </button>
              </>
            ) : job.status === "FAILED" ? (
              <p className="text-xs text-danger">{job.errorMessage ?? "Voice over generation failed."}</p>
            ) : job.status === "CANCELLED" ? (
              <p className="text-xs text-ink-muted">Cancelled.</p>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-success">Voice over ready.</p>
                {appliedJobId === job.id ? (
                  <button onClick={onRemove} className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink hover:border-danger hover:text-danger">
                    Remove from timeline
                  </button>
                ) : (
                  <button onClick={applyToTimeline} className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-brand/90">
                    Add to timeline
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <button
          onClick={generate}
          disabled={running || !providerId || lines.every((l) => !l.text.trim())}
          className="w-full rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-ink hover:bg-brand/90 disabled:opacity-40"
        >
          {running ? "Generating…" : "Generate voice over"}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-ink-muted">
          Generated speech is added as a separate audio track. Your original audio is never overwritten.
        </p>
      </div>
    </aside>
  );
}

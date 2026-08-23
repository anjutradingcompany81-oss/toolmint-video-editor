import type { SaveStatus } from "@/lib/use-composition-editor";

export default function SaveIndicator({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "saving") return <span className="text-xs text-ink-muted">Saving…</span>;
  if (status === "saved") return <span className="text-xs text-success">Saved</span>;
  // The reason used to live only in a title tooltip, so a save that kept
  // failing looked like an unexplained red label while every retry re-sent
  // the same rejected timeline. The server's message says exactly what is
  // wrong ("clips overlap", "an audio patch extends past the end of its
  // clip"), which is the difference between a dead end and a fix.
  if (status === "error")
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-danger" title={error ?? undefined}>
        <span className="shrink-0 font-medium">Couldn&apos;t save</span>
        {error && <span className="truncate text-danger/80">— {error}</span>}
      </span>
    );
  return <span className="text-xs text-ink-muted">Unsaved changes</span>;
}

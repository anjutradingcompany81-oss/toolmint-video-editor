import type { SaveStatus } from "@/lib/use-composition-editor";

export default function SaveIndicator({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "saving") return <span className="text-xs text-ink-muted">Saving…</span>;
  if (status === "saved") return <span className="text-xs text-success">Saved</span>;
  if (status === "error")
    return (
      <span className="text-xs text-danger" title={error ?? undefined}>
        Couldn&apos;t save
      </span>
    );
  return <span className="text-xs text-ink-muted">Unsaved changes</span>;
}

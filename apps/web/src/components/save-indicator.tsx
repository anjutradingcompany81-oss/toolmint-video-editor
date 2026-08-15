import type { SaveStatus } from "@/lib/use-composition-editor";

export default function SaveIndicator({ status, error }: { status: SaveStatus; error: string | null }) {
  if (status === "saving") return <span className="text-xs text-[var(--tm-text-dim)]">Saving…</span>;
  if (status === "saved") return <span className="text-xs text-[var(--tm-accent)]">Saved</span>;
  if (status === "error")
    return (
      <span className="text-xs text-red-400" title={error ?? undefined}>
        Couldn&apos;t save
      </span>
    );
  return <span className="text-xs text-[var(--tm-text-dim)]">Unsaved changes</span>;
}

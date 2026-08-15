export default function VideoEditorPlaceholder() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-3 px-6 text-center">
      <p className="text-sm uppercase tracking-wide text-[var(--tm-text-dim)]">Coming in Phase 2</p>
      <h1 className="text-2xl font-semibold">The editor isn&apos;t built yet</h1>
      <p className="text-[var(--tm-text-dim)]">
        This route is reserved for the storyboard and timeline editor. It will
        replace this placeholder once the Core MVP Editor module ships.
      </p>
    </main>
  );
}

// A debouncer that can also be flushed on demand — the general shape
// behind autosave: rapid edits coalesce into one call with the latest
// args after `delayMs` of quiet, but a caller that's about to do
// something irreversible with the saved state (starting an export, above
// all) needs a way to skip the wait and know the save actually landed,
// not just that it was scheduled. Framework-independent on purpose: the
// coalescing/flush logic is the part worth getting right and testing in
// isolation, with the calling hook only wiring React state around it.
export interface FlushableDebouncer<TArgs> {
  /** Schedules `run(args)` after the delay, replacing any not-yet-run schedule. */
  schedule(args: TArgs): void;
  /**
   * Runs the latest scheduled call immediately (or joins one already in
   * flight), and resolves with whether the most recent completed run
   * succeeded. Resolves `true` immediately if nothing was pending and
   * nothing has ever failed.
   */
  flush(): Promise<boolean>;
  /** Drops a pending (not-yet-run) schedule — e.g. on unmount, so a stray edit doesn't fire a request nobody's there to see the result of. Does not affect a run already in flight. */
  cancel(): void;
}

export function createFlushableDebouncer<TArgs>(run: (args: TArgs) => Promise<boolean>, delayMs: number): FlushableDebouncer<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: TArgs | null = null;
  let inFlight: Promise<boolean> | null = null;
  let lastResult = true;

  function launch(args: TArgs): void {
    inFlight = run(args)
      .then((ok) => {
        lastResult = ok;
        return ok;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return {
    schedule(args: TArgs) {
      if (timer) clearTimeout(timer);
      pendingArgs = args;
      timer = setTimeout(() => {
        timer = null;
        const scheduledArgs = pendingArgs as TArgs;
        pendingArgs = null;
        launch(scheduledArgs);
      }, delayMs);
    },
    async flush(): Promise<boolean> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        const args = pendingArgs;
        pendingArgs = null;
        if (args !== null) launch(args);
      }
      if (inFlight) return inFlight;
      return lastResult;
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pendingArgs = null;
    },
  };
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFlushableDebouncer } from "./flushable-debounce";

describe("createFlushableDebouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the scheduled call only after the delay elapses", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("coalesces rapid schedule() calls into a single run of the latest args", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    await vi.advanceTimersByTimeAsync(500);
    debouncer.schedule("b");
    await vi.advanceTimersByTimeAsync(500);
    debouncer.schedule("c");
    await vi.advanceTimersByTimeAsync(1500);

    expect(run).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("flush() runs a pending schedule immediately instead of waiting out the delay — the export race", async () => {
    // Reproduces the reported bug: a clip edit schedules an autosave, and
    // clicking Export moments later must not proceed against whatever was
    // saved *before* that edit.
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("edited-timeline");
    expect(run).not.toHaveBeenCalled(); // still inside the debounce window

    const ok = await debouncer.flush();
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith("edited-timeline");
  });

  it("flush() joins an already-in-flight run instead of starting a second one", async () => {
    let resolveRun: (ok: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((resolve) => (resolveRun = resolve)));
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    await vi.advanceTimersByTimeAsync(1500); // timer fires, run() is now in flight
    expect(run).toHaveBeenCalledTimes(1);

    const flushPromise = debouncer.flush(); // must not call run() again
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun(true);
    expect(await flushPromise).toBe(true);
  });

  it("flush() resolves true immediately when nothing is pending and the last run (if any) succeeded", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    expect(await debouncer.flush()).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("flush() reports failure — and does not silently proceed — when the save failed", async () => {
    const run = vi.fn().mockResolvedValue(false);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    expect(await debouncer.flush()).toBe(false);
  });

  it("remembers the last completed result until a new schedule overrides it", async () => {
    const run = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    expect(await debouncer.flush()).toBe(false); // first save failed

    debouncer.schedule("b");
    expect(await debouncer.flush()).toBe(true); // second save succeeded — no longer stuck reporting failure
  });

  it("cancel() drops a pending schedule without running it", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    debouncer.cancel();
    await vi.advanceTimersByTimeAsync(1500);

    expect(run).not.toHaveBeenCalled();
  });

  it("cancel() does not affect a run already in flight", async () => {
    let resolveRun: (ok: boolean) => void = () => {};
    const run = vi.fn(() => new Promise<boolean>((resolve) => (resolveRun = resolve)));
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    await vi.advanceTimersByTimeAsync(1500);
    debouncer.cancel();

    resolveRun(true);
    expect(await debouncer.flush()).toBe(true);
  });

  it("a schedule() that arrives after flush() started a run still gets its own fresh run", async () => {
    const run = vi.fn().mockResolvedValue(true);
    const debouncer = createFlushableDebouncer(run, 1500);

    debouncer.schedule("a");
    await debouncer.flush();
    expect(run).toHaveBeenCalledTimes(1);

    debouncer.schedule("b");
    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith("b");
  });
});

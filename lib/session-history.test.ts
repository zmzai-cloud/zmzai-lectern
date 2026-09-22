import { describe, expect, it, vi } from "vitest";
import { SessionHistory, type HistoryPage } from "./session-history.js";

const page = (hasMore = true): HistoryPage => ({
  messages: [{ info: { id: "m", role: "assistant" }, parts: [] }] as HistoryPage["messages"],
  beforeCursor: hasMore ? "cursor-1" : null,
  hasMoreBefore: hasMore,
  historyRevision: 1,
  snapshotSeq: 2,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("session history recovery", () => {
  it("retries failed initial history without advancing offset", async () => {
    const fetchPage = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page());
    const apply = vi.fn();
    const onState = vi.fn();
    const history = new SessionHistory({ fetchPage, apply, onState });
    await history.load();
    expect(onState).toHaveBeenLastCalledWith({ phase: "initial", loading: false, error: "offline", hasMore: false });
    expect(apply).not.toHaveBeenCalled();
    await history.load();
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, null]);
    expect(apply).toHaveBeenCalledWith(page(), true, "older");
    expect(onState).toHaveBeenLastCalledWith({ phase: "ready", loading: false, error: null, hasMore: true, hasNewer: false });
  });

  it("keeps earlier pages and offset on pagination failure, then supports explicit retry", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page(false));
    const apply = vi.fn();
    const onState = vi.fn();
    const history = new SessionHistory({ fetchPage, apply, onState });
    await history.load();
    await history.load();
    expect(onState).toHaveBeenLastCalledWith({ phase: "older", loading: false, error: "offline", hasMore: true, hasNewer: false });
    await history.load();
    await history.load();
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, "cursor-1", "cursor-1"]);
    expect(apply).toHaveBeenLastCalledWith(page(false), false, "older");
  });

  it.each([false, true])("discards late success/failure after switching session (failure=%s)", async failure => {
    const pending = deferred<HistoryPage>();
    const fetchPage = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(pending.promise);
    const apply = vi.fn();
    const onState = vi.fn();
    const history = new SessionHistory({ fetchPage, apply, onState });
    await history.load();
    const loading = history.load();
    history.dispose();
    expect(fetchPage.mock.calls[1]![1].aborted).toBe(true);
    apply.mockClear();
    onState.mockClear();
    if (failure) pending.reject(new Error("late error"));
    else pending.resolve(page(false));
    await loading;
    await history.load();
    expect(apply).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent requests", async () => {
    const pending = deferred<HistoryPage>();
    const fetchPage = vi.fn().mockReturnValue(pending.promise);
    const history = new SessionHistory({ fetchPage, apply: vi.fn(), onState: vi.fn() });
    const first = history.load();
    await history.load();
    expect(fetchPage).toHaveBeenCalledOnce();
    pending.resolve(page());
    await first;
  });

  it("preserves evicted cursors and loads the opposite edge", async () => {
    const fetchPage = vi.fn().mockResolvedValue(page());
    const onState = vi.fn();
    const history = new SessionHistory({ fetchPage, apply: vi.fn(), onState });
    await history.load();
    history.setBoundary("after", "evicted-tail");
    await history.load("newer");
    expect(fetchPage).toHaveBeenLastCalledWith("evicted-tail", expect.any(AbortSignal), "newer");
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ hasMore: true, hasNewer: false }));
    await history.load("latest");
    expect(fetchPage).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), "latest");
  });

  it("latest supersedes a pending old page even when transport ignores abort", async () => {
    const old = deferred<HistoryPage>();
    const fetchPage = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page(false));
    const apply = vi.fn();
    const history = new SessionHistory({ fetchPage, apply, onState: vi.fn() });
    await history.load();
    const loading = history.load();
    await history.load("latest");
    old.resolve(page());
    await loading;
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(page(false), true, "latest");
  });
});

import type { LecternEvent, TranscriptMessage } from "./types.js";

export type HistoryPage = { messages: TranscriptMessage[]; beforeCursor: string | null; afterCursor?: string | null; hasMoreAfter?: boolean; hasMoreBefore: boolean; historyRevision: number; snapshotSeq: number; stateEvents?: LecternEvent[]; readState?: import("./types.js").ReadState; /** 该水位上的任务契约（规格 3 §13.3）。undefined = 该分页没带，null = 服务端确认无任务。 */ task?: import("./types.js").TaskRecordView | null };
export type HistoryDirection = "older" | "newer" | "latest";
export type HistoryState = {
  phase: "initial" | "older" | "newer" | "latest" | "ready";
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  hasNewer?: boolean;
};
export const EMPTY_HISTORY_STATE: HistoryState = { phase: "ready", loading: false, error: null, hasMore: false };

/** One loader per selected session. Disposal rejects even transports ignoring abort. */
export class SessionHistory {
  private disposed = false;
  private initialized = false;
  private cursor: string | null = null;
  private after: string | null = null;
  private request: AbortController | null = null;
  private state: HistoryState = { ...EMPTY_HISTORY_STATE, phase: "initial" };

  constructor(private readonly options: {
    fetchPage: (cursor: string | null, signal: AbortSignal, direction?: HistoryDirection) => Promise<HistoryPage>;
    apply: (page: HistoryPage, initial: boolean, direction?: HistoryDirection) => void;
    onState: (state: HistoryState) => void;
  }) {}

  async load(direction: HistoryDirection = "older"): Promise<void> {
    if (direction === "latest" && this.request) { this.request.abort(); this.request = null; }
    if (this.disposed || this.request || (this.initialized && (direction === "older" ? !this.state.hasMore : direction === "newer" ? !this.state.hasNewer : false))) return;
    const request = new AbortController();
    this.request = request;
    const previous = { cursor: this.cursor, after: this.after, state: this.state };
    const initial = !this.initialized || direction === "latest";
    this.update({ ...this.state, phase: !this.initialized ? "initial" : direction, loading: true, error: null });
    try {
      const page = await this.options.fetchPage(initial ? null : direction === "newer" ? this.after : this.cursor, request.signal, direction);
      if (this.disposed || request.signal.aborted) return;
      if (initial || direction === "older") this.cursor = page.beforeCursor;
      if (initial || direction === "newer") this.after = page.afterCursor ?? null;
      this.state = { ...this.state, hasMore: initial || direction === "older" ? page.hasMoreBefore : this.state.hasMore, hasNewer: initial || direction === "newer" ? !!page.hasMoreAfter : this.state.hasNewer };
      this.options.apply(page, initial, direction);
      this.initialized = true;
      this.update({ ...this.state, phase: "ready", loading: false, error: null });
    } catch (error) {
      if (this.disposed || request.signal.aborted) return;
      this.cursor = previous.cursor;
      this.after = previous.after;
      if (direction !== "latest" && (error as { status?: number })?.status === 409) {
        this.request = null;
        await this.load("latest");
        return;
      }
      this.update({ ...previous.state, phase: initial ? "initial" : direction, loading: false, error: error instanceof Error ? error.message : "历史消息加载失败" });
    } finally {
      if (this.request === request) this.request = null;
    }
  }

  setBoundary(side: "before" | "after", cursor: string): void {
    if (side === "before") { this.cursor = cursor; this.state = { ...this.state, hasMore: true }; }
    else { this.after = cursor; this.state = { ...this.state, hasNewer: true }; }
    this.options.onState(this.state);
  }

  get hasNewer(): boolean { return !!this.state.hasNewer; }

  dispose(): void {
    this.disposed = true;
    this.request?.abort();
  }

  private update(state: HistoryState): void {
    this.state = state;
    this.options.onState(state);
  }
}

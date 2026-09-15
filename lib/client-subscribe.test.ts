import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "./client";
import { ChatProjector } from "./chat-projector";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage?: (event: { data: string }) => void;
  onopen?: () => void;
  onerror?: () => void;
  close = vi.fn();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  emit(seq: number, type = "session.status", data: unknown = { status: "idle" }, sessionId = "a") {
    this.onmessage?.({ data: JSON.stringify({ seq, type, data, sessionId }) });
  }
}
const latest = () => FakeEventSource.instances.at(-1)!;
beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("session event subscriptions", () => {
  it("starts catch-up strictly after the snapshot watermark", () => {
    const apply = vi.fn();
    const stop = client.subscribe("a",apply,undefined,12);
    expect(latest().url).toContain("?since=12");
    latest().emit(12);
    latest().emit(13);
    expect(apply.mock.calls.map(([event]) => event.seq)).toEqual([13]);
    stop();
  });
  it("applies duplicate deltas only once, including replay after reconnect", () => {
    const projector = new ChatProjector();
    const stop = client.subscribe("a", event => projector.ingest(event));
    latest().emit(1, "message.updated", { message: { id: "m", role: "assistant" } });
    const delta = { messageId: "m", partId: "p", delta: "hello" };
    latest().emit(2, "message.part.delta", delta);
    latest().emit(2, "message.part.delta", delta);
    latest().onerror?.();
    vi.advanceTimersByTime(1000);
    expect(latest().url).toContain("?since=2");
    latest().emit(2, "message.part.delta", delta);
    latest().emit(3, "message.part.delta", { ...delta, delta: " world" });
    expect(projector.data().messages[0]!.parts[0]!.part).toMatchObject({ text: "hello world" });
    stop();
  });

  it("replays gaps from the applied cursor and ignores late frames from replaced sources", () => {
    const apply = vi.fn();
    const stop = client.subscribe("a", apply);
    const old = latest();
    old.emit(1);
    old.emit(3);
    old.emit(2);
    old.onerror?.();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toContain("?since=1");
    latest().emit(2);
    latest().emit(3);
    latest().emit(1);
    expect(apply.mock.calls.map(([event]) => event.seq)).toEqual([1, 2, 3]);
    stop();
  });

  it("does not advance the cursor when application fails", () => {
    const apply = vi.fn().mockImplementationOnce(() => { throw new Error("projection failed"); });
    const stop = client.subscribe("a", apply);
    latest().emit(1);
    vi.advanceTimersByTime(1000);
    expect(latest().url).not.toContain("since");
    latest().emit(1);
    latest().onerror?.();
    vi.advanceTimersByTime(1000);
    expect(latest().url).toContain("?since=1");
    stop();
  });

  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, null])("rejects invalid cursor %s", seq => {
    const apply = vi.fn();
    const stop = client.subscribe("a", apply);
    latest().onmessage?.({ data: JSON.stringify({ seq, sessionId: "a", type: "session.status", data: {} }) });
    expect(apply).not.toHaveBeenCalled();
    expect(latest().close).toHaveBeenCalledOnce();
    stop();
  });

  it("rejects malformed frames and wrong-session events", () => {
    const apply = vi.fn();
    const stop = client.subscribe("a", apply);
    latest().onmessage?.({ data: "{bad" });
    vi.advanceTimersByTime(1000);
    latest().emit(1, "session.status", {}, "b");
    expect(apply).not.toHaveBeenCalled();
    stop();
  });

  it("keeps reconnect backoff across open/error loops and stops all callbacks on disposal", () => {
    const apply = vi.fn();
    const state = vi.fn();
    const stop = client.subscribe("a", apply, state);
    for (const delay of [1000, 2000, 4000]) {
      latest().onopen?.();
      latest().onerror?.();
      vi.advanceTimersByTime(delay);
    }
    expect(state).toHaveBeenCalledWith("offline");
    stop();
    state.mockClear();
    latest().emit(1);
    latest().onopen?.();
    latest().onerror?.();
    vi.runAllTimers();
    expect(FakeEventSource.instances).toHaveLength(4);
    expect(apply).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
  });
});

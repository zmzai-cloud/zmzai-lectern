import { useEffect, useRef, useState, type RefObject } from "react";
import { client } from "./client.js";
import { ReadDwell } from "./read-dwell.js";
import type { ReadState } from "./types.js";

export function useSessionReadState(sessionId: string | null, root: RefObject<HTMLDivElement | null>, canRead: boolean, latestVisibleSeq: number, revisionHint: number) {
  const [state, setState] = useState<ReadState | null>(null);
  const allowed = useRef(canRead);
  allowed.current = canRead;
  const latest = useRef(latestVisibleSeq);
  latest.current = latestVisibleSeq;
  useEffect(() => {
    setState(null);
    if (!sessionId) return;
    const request = new AbortController();
    let current: ReadState | null = null;
    let disposed = false;
    let refreshing = false;
    let committing = false;
    const eligible = () => {
      const el = root.current;
      return allowed.current && document.visibilityState === "visible" && document.hasFocus() && !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    };
    const check = () => dwell.update(!committing && current && eligible() && Math.min(latest.current, current.latestMessageSeq) > current.lastReadMessageSeq
      ? `${current.historyRevision}:${Math.min(latest.current, current.latestMessageSeq)}` : null);
    const refresh = async () => {
      if (refreshing || committing || disposed) return;
      refreshing = true;
      try {
        const value = await client.getReadState(sessionId, request.signal);
        if (!disposed) { current = value; setState(value); check(); }
      } catch { /* Preserve server state and retry on the next poll/focus. */ }
      finally { refreshing = false; }
    };
    const dwell = new ReadDwell(key => {
      const [historyRevision, sequence] = key.split(":").map(Number);
      committing = true;
      void client.markRead(sessionId, sequence, historyRevision, request.signal).then(value => {
        if (disposed) return;
        current = value; setState(value);
        window.dispatchEvent(new CustomEvent("lectern:read-state", { detail: { sessionId, readState: value } }));
      }).catch(() => { current = null; }).finally(() => { committing = false; if (!disposed) void refresh(); });
    }, eligible);
    const focus = () => { check(); void refresh(); };
    const el = root.current;
    el?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("focus", focus);
    window.addEventListener("blur", check);
    document.addEventListener("visibilitychange", focus);
    const interval = setInterval(() => { check(); void refresh(); }, 1000);
    void refresh();
    return () => {
      disposed = true; request.abort(); dwell.cancel(); clearInterval(interval);
      el?.removeEventListener("scroll", check);
      window.removeEventListener("focus", focus); window.removeEventListener("blur", check);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [sessionId, root, revisionHint, canRead]);
  return state;
}

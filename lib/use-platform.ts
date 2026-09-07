"use client";

import { useEffect, useState } from "react";

/** Stable server render; native platform wins over the browser fallback. */
export function usePlatform() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const native = window.lecternNative?.platform;
    setIsMac(native ? native === "darwin" : /Mac/i.test(navigator.platform));
  }, []);
  return { isMac, modifier: isMac ? "⌘" : "Ctrl+", shift: isMac ? "⇧" : "Shift+" };
}

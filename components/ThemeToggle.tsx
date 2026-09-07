"use client";

import { useEffect, useState } from "react";
import { cn } from "@zmzai/theme";

type ThemePref = "system" | "light" | "dark";

const OPTIONS: { key: ThemePref; label: string; icon: React.ReactNode }[] = [
  {
    key: "system",
    label: "跟随系统",
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
        <path d="M5.5 14.5h5M8 11.5v3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "light",
    label: "浅色",
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="3.2" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "dark",
    label: "深色",
    icon: (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M13.5 9.5A6 6 0 1 1 6.5 2.5a5 5 0 0 0 7 7Z" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function applyPref(pref: ThemePref) {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
}

/** 三态主题切换（system/light/dark），与 layout.tsx 的首帧 bootstrap 脚本配套。 */
export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    const sync = () => { const stored = localStorage.getItem("zmzai-theme"); setPref(stored === "dark" || stored === "light" ? stored : "system"); };
    sync();
    window.addEventListener("lectern:theme-change", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("lectern:theme-change", sync); window.removeEventListener("storage", sync); };
  }, []);

  const select = (next: ThemePref) => {
    setPref(next);
    localStorage.setItem("zmzai-theme", next);
    applyPref(next);
    window.dispatchEvent(new Event("lectern:theme-change"));
  };

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-pill border border-line bg-surface p-0.5"
      role="radiogroup"
      aria-label="主题"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={pref === o.key}
          title={o.label}
          onClick={() => select(o.key)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 justify-center rounded-full px-2.5 text-xs transition-colors",
            pref === o.key ? "bg-ink text-paper" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

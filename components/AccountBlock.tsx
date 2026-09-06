"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { client } from "@/lib/client";
import type { AuthStatus } from "@/lib/types";

/**
 * 左下角账户块（Qoder 式）：头像 + 用户名，右侧齿轮弹出更多菜单
 * （用户信息 / 主题三选 / 登录 relay / 退出登录）。
 * 工作台侧栏与设置页 aside 共用；登录态自含拉取，
 * onChange 供外部联动（如设置页登录态变化后刷新 relay key 列表）。
 */
export default function AccountBlock({ onChange }: { onChange?: (auth: AuthStatus) => void }) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [menu, setMenu] = useState(false);
  const [themePref, setThemePref] = useState<"system" | "light" | "dark">("system");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    void client
      .authStatus()
      .then((a) => {
        setAuth(a);
        onChange?.(a);
      })
      .catch(() => undefined);
  }, [onChange]);

  useEffect(() => {
    refresh();
    const stored = localStorage.getItem("zmzai-theme");
    if (stored === "light" || stored === "dark" || stored === "system") setThemePref(stored);
  }, [refresh]);

  // 外点关闭菜单
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  // 与 ThemeToggle 同一 localStorage 约定（zmzai-theme）
  const pickTheme = (pref: "system" | "light" | "dark") => {
    setThemePref(pref);
    localStorage.setItem("zmzai-theme", pref);
    if (pref === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pref;
  };

  const logout = () => {
    if (busy) return;
    setBusy(true);
    void client
      .authLogout()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        setMenu(false);
        refresh();
      });
  };

  return (
    <div ref={ref} className="relative">
      {menu && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-md border border-line bg-surface p-1 shadow-lg ring-1 ring-line">
          <div className="px-2.5 pb-2 pt-2">
            <div className="truncate text-xs font-medium text-ink">{auth?.user?.name ?? "未登录"}</div>
            <div className="truncate text-[0.625rem] text-ink-3">{auth?.user?.email ?? "登录后可同步账号能力"}</div>
          </div>
          <div className="border-t border-line py-1">
            <div className="px-2.5 pb-1 pt-1.5 text-[0.625rem] text-ink-3">主题</div>
            {(["system", "light", "dark"] as const).map((pref) => (
              <button
                key={pref}
                type="button"
                onClick={() => pickTheme(pref)}
                className={
                  "flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] transition-colors " +
                  (themePref === pref ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-3")
                }
              >
                {pref === "system" ? "跟随系统" : pref === "light" ? "浅色" : "深色"}
              </button>
            ))}
          </div>
          <div className="border-t border-line pt-1">
            <Link
              href="/settings"
              onClick={() => setMenu(false)}
              className="flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
            >
              设置
            </Link>
            {typeof window !== "undefined" && window.lecternNative?.openLogsFolder && (
              <button
                type="button"
                onClick={() => {
                  void window.lecternNative?.openLogsFolder?.();
                  setMenu(false);
                }}
                title="内嵌服务运行日志（web.log），报障时请一并发来"
                className="flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                打开日志文件夹
              </button>
            )}
            {auth?.loggedIn ? (
              <button
                type="button"
                disabled={busy}
                onClick={logout}
                className="flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] text-danger transition-colors hover:bg-surface-3"
              >
                退出登录
              </button>
            ) : (
              <Link
                href="/login"
                onClick={() => setMenu(false)}
                className="flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                用户登录
              </Link>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        title="账户与更多"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
      >
        {auth?.loggedIn && auth.user ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-bg">
            {auth.user.name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs text-ink-3">?</span>
        )}
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[0.6875rem] font-medium text-ink">{auth?.user?.name ?? "未登录"}</span>
          <span className="block truncate text-[0.625rem] text-ink-3">{auth?.loggedIn ? "登录会话可用" : "可配置个人 key 直连"}</span>
        </span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="shrink-0 text-ink-3">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

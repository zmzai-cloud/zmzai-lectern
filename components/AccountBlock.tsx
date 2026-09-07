"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserRound, ChevronUp } from "lucide-react";

import { client } from "@/lib/client";
import type { AuthStatus, UpdateState } from "@/lib/types";

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
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const refresh = useCallback(() => {
    void client
      .authStatus()
      .then((a) => {
        setAuth(a);
        onChangeRef.current?.(a);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const sync = () => { const stored = localStorage.getItem("zmzai-theme"); setThemePref(stored === "dark" || stored === "light" ? stored : "system"); };
    sync();
    window.addEventListener("lectern:theme-change", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("lectern:theme-change", sync); window.removeEventListener("storage", sync); };
  }, [refresh]);

  useEffect(() => {
    const bridge = window.lecternNative;
    if (!bridge?.updateState) return;
    void bridge.updateState().then(setUpdate).catch(() => undefined);
    return bridge.onUpdateStatus?.(setUpdate);
  }, []);

  const updateAction = () => {
    const bridge = window.lecternNative;
    if (!bridge) return;
    if (update?.status === "available") void bridge.updateDownload?.();
    else if (update?.status === "ready") void bridge.updateInstall?.();
    else void bridge.updateCheck?.();
  };

  // 外点关闭菜单
  useEffect(() => {
    if (!menu) return;
    ref.current?.querySelector<HTMLButtonElement>("#account-options button")?.focus();
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", close);
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); triggerRef.current?.focus(); } };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [menu]);

  // 与 ThemeToggle 同一 localStorage 约定（zmzai-theme）
  const pickTheme = (pref: "system" | "light" | "dark") => {
    setThemePref(pref);
    localStorage.setItem("zmzai-theme", pref);
    if (pref === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pref;
    window.dispatchEvent(new Event("lectern:theme-change"));
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
    <div ref={ref} className="account-block relative">
      {menu && (
        <div id="account-options" className="account-menu absolute bottom-full left-0 z-30 mb-2 w-64 max-w-[calc(100vw-32px)] rounded-xl border border-line bg-bg p-2 shadow-lg">
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
                aria-pressed={themePref === pref}
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
            {typeof window !== "undefined" && window.lecternNative?.updateCheck && (
              <button
                type="button"
                onClick={updateAction}
                disabled={update?.status === "checking" || update?.status === "downloading"}
                className="flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-[0.75rem] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-50"
              >
                <span>{update?.status === "ready" ? (window.lecternNative?.platform === "darwin" ? "查看更新包并手动替换" : `安装 v${update.version}`) : update?.status === "available" ? `下载 v${update.version}` : update?.status === "downloading" ? `下载更新 ${update.percent}%` : update?.status === "checking" ? "正在检查更新…" : update?.status === "error" ? "重试检查更新" : "检查更新"}</span>
                {update?.status === "current" && <span className="text-[0.625rem] text-ink-3">已是最新</span>}
              </button>
            )}
            {update?.error && <p role="status" className="px-2.5 py-1 text-[0.6875rem] text-ink-3 break-words">{update.error}</p>}
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
        ref={triggerRef}
        type="button"
        aria-expanded={menu}
        aria-controls="account-options"
        onClick={() => setMenu((v) => !v)}
        title="账户与更多"
        className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <UserRound size={17} strokeWidth={1.5} className="shrink-0 text-ink-2" aria-hidden />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[0.6875rem] font-medium text-ink">{auth?.user?.name ?? "未登录"}</span>
          <span className="block truncate text-[0.625rem] text-ink-3">{auth?.loggedIn ? "个人账户" : "登录或连接模型"}</span>
        </span>
        <ChevronUp size={14} className="text-ink-3" aria-hidden />
      </button>
    </div>
  );
}

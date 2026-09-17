"use client";

import TerminalPane from "./TerminalPane";

/**
 * Debug Area（visual-system-realignment spec §4.6，Phase 1）。
 *
 * 底部跨中央与右侧列的运行时区域。Phase 1 只提供真实的 Terminal；Problems /
 * Output / Debug Console 等 tab 仅在存在真实数据与行为时加入（§4.6 明文：禁止以
 * 空 placeholder 伪造完整 IDE），故本层目前只是一个薄包装 + 未来 debug tab 的
 * 注册点，不额外叠一根标题条（会与 TerminalPane 的会话 tab 行构成两层条，违背
 * V0 的收敛目标）。
 *
 * 职责边界（spec §5）：
 * - TerminalPane 持有全部 PTY 所有权与会话密集逻辑；DebugArea 不接管 PTY，
 *   也不将 shell 是否常驻映射成 Agent 任务状态。
 * - DebugArea 承载 collapse/focus 命令（收起按钮注入到 tab 行右侧）与未来 debug
 *   tab 注册点。
 */
export default function DebugArea({
  sessionId,
  onCollapse,
}: {
  sessionId?: string | null;
  /** 收起 Debug Area（⌘J / Ctrl+J 同源）。 */
  onCollapse?: () => void;
}) {
  return (
    <TerminalPane
      sessionId={sessionId}
      trailing={
        onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title="收起调试区（⌘J / Ctrl+J）"
            aria-label="收起调试区"
            aria-keyshortcuts="Meta+J Control+J"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#b8b8bd] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7797e8]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            >
              <path d="M3 6l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : undefined
      }
    />
  );
}

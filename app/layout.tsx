import type { Metadata } from "next";

import ElectronShellMarker from "@/components/ElectronShellMarker";

import "./globals.css";

export const metadata: Metadata = {
  title: "agent harness · zmzai",
  description: "zmzai Agent Harness — Web / Desktop 同构的 Agent 工作台",
};

/** 首帧前同步主题：localStorage（system/light/dark），显式 ?theme= 可强制（分享/验证用），
 *  避免 React 水合前深色用户看到一闪而过的白屏。
 *  同步标记桌面壳（preload 注入 lecternNative）：html.electron 启用集成标题栏样式
 *  （顶栏拖拽区 + 红绿灯让位），避免首帧布局跳动。 */
const themeBootstrap = `
(function () {
  if (window.lecternNative) {
    document.documentElement.classList.add("electron");
    document.documentElement.dataset.platform = window.lecternNative.platform || (/Mac/i.test(navigator.platform) ? "darwin" : /Win/i.test(navigator.platform) ? "win32" : "linux");
  }
  try {
    var q = new URLSearchParams(location.search).get("theme");
    var t = q === "dark" || q === "light" ? q : localStorage.getItem("zmzai-theme") || "system";
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  } catch (e) {
    // 隐私模式 / 禁用存储时读 localStorage 会抛异常。主题与桌面壳标记都只是锦上
    // 添花，绝不能让它阻断首帧渲染，所以这里只告警不抛出——否则「主题不生效」
    // 会是彻头彻尾的静默失败，无从排查。
    console.warn("[theme] 首帧主题引导失败，回退到默认主题:", e);
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <ElectronShellMarker />
        {children}
      </body>
    </html>
  );
}

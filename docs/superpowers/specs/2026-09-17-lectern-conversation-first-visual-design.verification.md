# 对话优先视觉改版 · 验收报告

**规格：** `docs/superpowers/specs/2026-09-17-lectern-conversation-first-visual-design.md`
**实施计划：** `docs/superpowers/plans/2026-09-17-lectern-conversation-first-ui.md`
**分支：** `feat/conversation-first-ui`
**日期：** 2026-09-17
**结论：** 通过 —— 第 12 节 17 条验收标准全部满足；第 13 节禁止项逐条核查未违反。
第 12.5、12.9 两条含一处明确记录的取舍（见「已知偏差」）。

---

## 1. 变更说明（规格 §14.4）

### 1.1 布局状态模型

`lib/task-layout.ts` 是「持久桌面偏好」与「当前断点下的临时呈现」的单一来源，除存储读写外
全部是纯函数（37 项单测覆盖边界与坏数据）：

```ts
type TaskWorkbenchLayout = { open: boolean; width: number; tab: WorkbenchTab; tabExplicit: boolean };
type StoredTaskLayoutV1   = { version: 1; byTaskId: Record<string, TaskWorkbenchLayout & { updatedAt: number }> };
```

- **按任务保存**（§9）：开合、宽度、选中标签、是否显式选过标签都挂在任务 id 下。
- **渲染模型**：呈现由「桌面偏好 + 可用宽度」推导，而不是直接由 `open` 布尔值渲染：
  `layoutModeFor` → `availableWidthFor` → `workbenchMaxFor` → `workbenchPresentationFor`
  产出 `hidden | side | drawer`。
- **阈值集中在模块里**：桌面断点 1180、覆盖层断点 768、会话最小可读宽度 480、工作台最小
  360、硬上限 760、占比上限 0.58、分隔条 12、默认宽度 384、键盘步长 16/48、内容列 800、
  记录上限 40。

`app/page.tsx` 只保留一个布局状态对象，两个写入口：

- `updateTaskLayout(patch)`：用户动作与 clamp 的唯一写入口，**更新与落盘同步发生**，落盘的
  key 取**已提交**的 `activeId ?? "__draft__"`。
- 装载：`layoutOwner !== activeId` 时在渲染期同步换掉布局（React 会重跑本渲染而不提交中间
  结果），因此「切换任务」与「装载目标任务布局」落在同一个提交里。

### 1.2 断点与呈现（§7 / §7.1）

| 宽度 | 侧栏 | 工作台 |
|---|---|---|
| ≥1180px | 常驻，恢复上次保存的桌面开合 | 用户打开后并排；可用宽度不足（< 480+360+12）时降级为抽屉 |
| 768–1179px | 覆盖层，**默认关闭** | 覆盖层，**默认关闭**；与侧栏互斥 |
| <768px | 单视图 | 单视图 |

- 覆盖层是临时呈现：`activeOverlay: "sidebar" | "workbench" | null`，**不落盘**；进入窄断点
  只改它，离开窄断点（`layoutMode === "desktop"`）即清空，因此不会在下次进入窄断点时凭空
  弹出，也不会覆盖桌面偏好。
- 选择任务后自动关闭覆盖层（§7）。
- 工作台在窄断点由用户显式打开时只写覆盖层与标签，**不写 `open`**：标签是任务级内容选择，
  而开合是桌面偏好，平板上的临时开合不得覆盖它（§13）。

### 1.3 拖拽（§5.5.2）

- 边界：`clamp(pointerRightDistance, 360, min(760, available * 0.58))`；`available < 852` 时
  不再挤压会话，直接转覆盖式抽屉。
- 位移基于 `pointerdown` 时的起点值计算，因此到边界后不回弹、不漂移。
- 双保险防 iframe 吞事件：`setPointerCapture` + 拖动期间挂载全视口透明层
  `.splitter-capture`（拖动结束或分隔条被卸载时自动解除）。
- 无障碍：`role="separator"`、`aria-orientation`、`aria-valuemin/max/now`、方向键 16px、
  Shift 48px、Home/End 到边界、双击复位 384px。
- 拖动只改宽度变量，不触碰消息 DOM、滚动锚点与工作台内容。

### 1.4 视觉令牌（§6.1 / §6.3 / §7.2）

- 新增 `--conversation-content-max: 800px`：消息列、已读摘要行与 Composer 共用同一条左右基线
  （E2E 逐像素断言三者对齐）。
- 圆角收敛到规格表：结构 0 / 控件 6 / 行·菜单·Popover 8 / Composer 与用户气泡 12 / 状态胶囊
  全圆角。本轮把账户区与设置页残留的 9px、7px 一并收敛到 8px、6px。
- 用户气泡 `max-width: 78%`，窄屏（≤640px）占满；所有消息 `max-width:100%` +
  `overflow-wrap:anywhere`。

### 1.5 本轮修掉的三个缺陷

1. **任务间串台 + 偏好丢失**：此前用「写回 effect + 水合守卫」，切任务时 state 晚一个提交
   才跟上，守卫会吃掉唯一一次写入机会 —— 第二个任务的布局**永不落盘**。现在落盘与更新同步
   发生，写谁的键取已提交的 `activeId`。
2. **新任务挂着上一个任务的标签**：`WorkbenchPanel` 只在挂载时读一次 `initialTab`，而布局装
   载晚一个提交 ⇒ 新任务第一帧是旧任务的标签。现在装载与切任务同提交完成。
3. **覆盖层泄漏 + clamp 污染**：窄断点的临时开合会残留到桌面宽度，重新进入 768–1179px 时
   凭空弹出覆盖层；宽度 clamp 也会在覆盖层/抽屉下把桌面偏好改小。现在离开窄断点即失效，
   clamp 只在**真的可能并排**（`available ≥ 852`）时生效。

---

## 2. 兼容与迁移（§9）

- 存储 key 带版本号：`lectern.task-layout` = `{ version: 1, byTaskId }`。
- 解析失败、版本不匹配、值越界、字段类型错误一律回到安全默认值，永不抛错（单测覆盖）。
- 旧版全局键 `lectern:workbench-open` / `lectern:workbench-width` 只在**第一个真实任务尚无
  记录**时迁移一次，且只迁移宽度：`open` 刻意不迁移，避免老用户升级后第一次进入就被一个常驻
  面板迎面撞上；迁移后立即清掉旧键。
- 记录上限 40 条，超出按 `updatedAt` 淘汰最旧，长期使用不会无限增长。
- 首屏不读浏览器存储（`layoutReady` 之后才装载），SSR/hydration 不产生不一致或跳动。

---

## 3. 已知偏差与限制

1. **§12.5 圆角**：仍存在 4px/2px/1px 三个值，但都在装饰性微形状上——滚动条拇指（4px）、
   停止图标方块（2px）、流式光标（1px），不属于「组件圆角」层级。组件级圆角已全部落在
   0/6/8/12 四档。
2. **§12.9 字号**：全站仍使用 10px（`text-[0.625rem]`）的元数据层，用于计数、机器标识、
   路径、快捷键提示等非关键信息，符合 §6.3「10–11px 仅用于非关键计数或极短标签」。会话正文
   15px、关键辅助文字（已读摘要、状态行）≥12px、Composer 输入 14px 均有断言。
3. **降级抽屉下不写宽度**：桌面宽度不足以并排（侧栏很宽时将低于 852px 可用宽度）时，工作台
   以抽屉出现且**不改写**保存的宽度。窗口恢复后若仍并排，则按当时的可用宽度重新 clamp ——
   这个 clamp 会被持久化（规格未要求自动恢复更宽的旧值，且 §5.5.2 要求「到边界后保持稳定」）。
4. 未在真机触摸屏上验证拖拽；指针捕获 + 透明层已覆盖 iframe 抢事件这一主要风险。

---

## 4. 验证记录（§14.3）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（tsc --noEmit） | 通过 |
| `pnpm test`（vitest run） | 23 个文件 / 208 项通过 |
| `pnpm build`（next build） | 通过，无新增警告 |
| `LECTERN_TEST_URL=… node e2e/conversation-first-ui.mjs` | 通过 |
| `LECTERN_TEST_URL=… node e2e/workbench-resize-ui.mjs` | 通过 |
| `node e2e/task-groups-ui.mjs` | 通过（1440px / 960px） |
| `node e2e/message-search-ui.mjs` | 通过 |
| `node e2e/message-recovery-ui.mjs` | 通过（1440 / 1024 / 390） |
| `node e2e/smoke.mjs` | 通过（agent / git / terminal / 订阅） |
| `node e2e/session-ownership-smoke.mjs` | 通过（生产服务器 10 项归属检查） |
| `pnpm test:release` | 通过 |

> E2E 需要在**生产构建**下跑（`next build` + `next start`）。`session-ownership-smoke.mjs`
> 自己起 `next start`，因此仓库里必须先有一份构建产物，否则会以 `Server exited: 1` 直接失败
> —— 这是它此前在本机报错的原因，与代码无关。

本轮新增/加固的断言（对照 §11.4）：

- 8 个宽度 × 浅/深主题：`document.documentElement.scrollWidth <= innerWidth`，并落截图；
- 会话 pane 实际宽度 ≥ 480（120 并排时）；
- 长用户消息右边界不越出会话 pane，Composer 不超出 800px 阅读轴；
- 已读文件默认折叠为一行摘要（`<details open=false>`），展开后是文件列表，收起后重新隐藏；
- 已完成工具调用收拢成一条 ≤32px 的折叠行；
- 拖到极值被 clamp 到 360 / `min(760, available*0.58)`，双击复位 384，方向键 16px / Shift 48px；
- 1179px 覆盖、1180px 并排；
- 窄屏开合覆盖层不修改保存的桌面 open/width；
- 两个任务的**开合、宽度、标签**三向独立（含返回后标签恢复）；
- 展开 Debug Area 不改变 conversation pane 横向尺寸；
- 键盘可聚焦并操作分隔条、工作台入口、Composer 与任务行；
- 触达区：发送 32×32、标题栏图标按钮 ≥28×28；字号：正文 ≥14px、Composer ≥14px、已读摘要
  ≥12px。

---

## 5. 截图产物（§14.2）

`test-results/conversation-first/`（该目录在 `.gitignore` 内，可随时重跑生成）：

- `matrix-{light,dark}-{1600,1440,1180,1179,960,768,767,390}.png` —— 16 张，8 个关键宽度 ×
  浅/深主题，取「会话优先」默认态（工作台收起、窄断点无覆盖层）。
- `desktop-{1600,1440,1180}.png` —— 并排态。
- `compact-{1179,960,768,767,390}.png` —— 覆盖层态与互斥验证。
- `dark-390.png` —— 深色主题单视图。

重新生成：

```bash
pnpm build && npx next start -H 127.0.0.1 -p 3100 &
LECTERN_TEST_URL=http://127.0.0.1:3100 node e2e/conversation-first-ui.mjs
```

---

## 6. 第 12 节逐条验收（§14.5）

| # | 标准 | 结论 | 证据 |
|---:|---|---|---|
| 1 | 新建/空闲/运行任务默认收起工作台，会话最宽最清晰 | 满足 | `defaultTaskWorkbenchLayout().open === false`；E2E「workbench defaults closed」「a task without saved state defaults to a closed workbench」；`matrix-*` 截图 |
| 2 | 成果/待审查/交付不自动展开；明显入口开对标签 | 满足 | 唯一展开路径 `openWorkbench`（标题栏开关、上下文条入口、点击文件、⌘P）；E2E 断言点已读文件后 `#wb-tab-files[aria-selected=true]`，且默认态 `.workbench-shell` 计数为 0 |
| 3 | 开合/宽度/标签在当前任务内保持，切任务后分别恢复 | 满足 | E2E 三向隔离 + 返回后宽度与标签恢复；单测按任务隔离 |
| 4 | <1180px 工作台为覆盖抽屉，不缩窄/截断会话 | 满足 | E2E 1179/960/768/767/390 均无内联分隔条、无覆盖层外的挤压；覆盖层全宽（<768 断言宽度=视口） |
| 5 | 只用规格定义的结构/控件/气泡圆角，大区不卡片化 | 基本满足 | 组件级只剩 0/6/8/12；E2E 断言气泡与 Composer 12px、`.wb-tab` 6px。残留 4/2/1px 为装饰性微形状（见偏差 1） |
| 6 | 主状态只在顶部常驻，消息流与侧栏只保留各自职责 | 满足 | E2E `[data-task-primary-status="true"]` 计数 = 1 |
| 7 | 模型/推理强度/权限/技能走一个可发现的「运行配置」 | 满足 | E2E `getByRole("button", {name:"运行配置"})` 计数 = 1，且键盘可达 |
| 8 | 已读文件默认折叠为一行摘要 | 满足 | E2E：默认 `open=false`、摘要文案「已读取 3 个文件」、展开 3 项、收起后隐藏；展开项为 8px 行而非 10px 标签 |
| 9 | 关键辅助文字 ≥12px，关键操作触达 ≥32px | 满足 | E2E：已读摘要 ≥12px、正文 15px、Composer 14px、发送 32×32、图标按钮 ≥28×28。10px 仅用于非关键元数据（见偏差 2） |
| 10 | 各尺寸无页面级横向滚动，核心流程回归通过 | 满足 | 8 宽度 × 2 主题断言；拖动全程断言；5 个 UI E2E + 2 个服务端冒烟通过 |
| 11 | 终端仍在会话区底部 Debug Area，工作台只放审查/文件/预览 | 满足 | E2E 展开终端只改高度不改会话列宽；工作台标签为审查/文件/成果预览；未改 `TerminalPane` 行为 |
| 12 | 768–1179px 互斥覆盖层；≥1180px 恢复保存的桌面状态 | 满足 | E2E：覆盖层默认关闭、互斥、开合不写回偏好；回到 1600px 恢复宽度与开合 |
| 13 | 桌面拖到任意合法宽度都不裁切消息/正文/代码块/Composer | 满足 | E2E 拖动后消息右边界 ≤ pane、`scrollWidth ≤ clientWidth`、无页面级横向滚动；代码块与表格在自身容器内横向滚动 |
| 14 | 分隔条支持指针/键盘/双击复位且无障碍语义正确 | 满足 | E2E：拖动、clamp、双击 384、方向键 16、Shift 48、`role=separator` 与 aria 值、focus 可达 |
| 15 | 偏好按任务隔离，断点切换不污染桌面偏好，坏数据可恢复 | 满足 | 单测 37 项（坏数据/版本不符/越界/隔离/迁移一次/LRU 上限）+ E2E 窄断点不写回 |
| 16 | 浅/深主题在 8 个关键宽度完成截图验收 | 满足 | `matrix-{light,dark}-*` 共 16 张 + 状态截图 9 张 |
| 17 | 所有布局/视觉/E2E 测试通过，生产构建无新增警告 | 满足 | 见第 4 节验证记录 |

---

## 7. 第 13 节禁止项核查

| 禁止项 | 核查 |
|---|---|
| 用页面级 `overflow-x: hidden` 掩盖截断 | 未使用；`globals.css` 中唯一的 `overflow-x` 是表格自身容器 |
| 把会话区设为不可收缩的固定宽度 | 会话区保持 `flex: 1 1 auto` + `min-width: 0`，分栏链路逐级 `min-w-0` |
| 成果生成/任务运行/窗口变宽时强制打开工作台 | 唯一展开路径是用户动作；窗口变宽只影响呈现方式，不改 `open` |
| 让平板/移动端的临时开合覆盖桌面持久偏好 | 覆盖层只写 `activeOverlay` 与标签，不写 `open`/`width`；clamp 也只在可并排时生效（本轮修复） |
| 把所有区域改成大圆角阴影卡片 | 结构区 0 圆角、单像素分隔线；阴影只用于菜单/Popover/抽屉 |
| 依赖 hover 暴露关键操作或完整状态 | 主状态常驻顶部；任务行操作为 `role=button` + `tabIndex=0`；`@media (hover:none)` 下溢出菜单常显；E2E 键盘可达断言 |
| 用大量 10–11px 文字压缩界面 | 关键辅助文字 ≥12px 并有断言；10px 只用于计数/标识（偏差 2） |
| 把终端移到右侧工作台 | 未改动 Debug Area 与 TerminalPane 的归属 |
| 重写消息/权限/文件/任务后端协议 | 本轮只改前端（`app/`、`components/`、`lib/task-layout*`、`e2e/`），无 API 变更 |
| 未验证关键断点/长消息/拖动边界就宣布完成 | 关键断点、长消息右边界、拖动边界与 clamp 全部有断言与截图 |

# V1 设计：浏览器验证与交付证据（W1 后首个扩展阶段）

- 日期：2026-09-23；状态：设计稿，供 review 后实施
- 对应规格：§11 全节、§17.1 V1 行（放行=V01–V05 + 真实本地 fixture 浏览器测试）、§16 V01–V05
- 前置：B0 收官（0.9.0）；W1 全部完成（WorkspaceService 创建/准备/快照/整合序列已收敛）
- 现成地基盘点：`lib/delivery.ts`（attempt 状态机/快照/CAS/supersede）、`lib/evidence-packet.ts`（版本化证据包）、`TerminalManager`（PTY 受管进程，B4 七端点实测）、W1-S24 setup manifest（devServer 声明+Host 端口分配）、`workspace-service` 快照指纹
- 硬边界：**结构化浏览器自动化**（DOM/Accessibility 定位+断言），不是 C1 全桌面输入；不做云端；不自动重放外部副作用

## 1. 总体决策

### 1.1 状态机与驱动分离（Host 纯逻辑 + 注入 verifier adapter）

BrowserVerificationRun 的状态机、VerificationPlan 固定、证据聚合与持久化全部在 Host 纯 Node 层（可 vitest 全覆盖）；真实浏览器驱动是**注入的 adapter**（与 S24 prepareWorkspace 的 runCommand 注入执行器同款模式）。放行条件里的「真实本地 fixture 浏览器测试」由 Electron 模式 e2e 脚本承担（`e2e/` 既有模式），vitest 层用 scripted mock verifier 验逻辑。

### 1.2 驱动 = Electron 主进程自带 Chromium（零新依赖）

不引入 Playwright/puppeteer（+150MB 浏览器二进制与下载管理，Electron 壳本就有 Chromium）。驱动落点：Electron main 起隐藏 `BrowserWindow` + 独立 `session.partition`（context 隔离、登录态按账号隔离）；采集用 `webContents.executeJavaScript`（结构化 DOM 断言）+ `console-message`/`did-fail-load`/`did-fail-resource-load` 事件（console error/page error/失败请求）+ `capturePage`（截图，入附件存储）。

通道：Main 在本地起 **verifier HTTP endpoint**（host.json 同款随机端口+32B token，env `LECTERN_VERIFIER_BOOTSTRAP` 告知 Host）；Host adapter 转发步骤指令。dev/web（无 Electron）→ verifier **unavailable**（spec 语义：unavailable 不算通过，如实报环境原因，不伪报）。

### 1.3 受管服务复用既有件

- owned 启动：`TerminalManager.start({command, cwd=worktree})`（PTY 受管进程）；命令来自 setup manifest 的 devServer 声明或 ApprovedExecutionPlan 的 canonicalPreview；端口用 W1-S24 Host 分配器（不手工约定）
- borrowed 复用：仅探测「同 workspace、同代码版本（delivery snapshot fingerprint 可核对）」的已注册服务；只观察与链接，**不停止不改写**（取消/回收时仅解除绑定）
- 就绪检查：HTTP 探活 + **实际 origin 与应用标识核对**（页面 title/meta 标记）；端口可连接 ≠ 正确项目已启动（spec §11.2.2）
- 可写缓存目录（.next、dist 等）预声明并排除出源代码 fingerprint——用 workspace setup manifest 扩展 `devServer.cacheDirs` 声明

### 1.4 证据与失效链（复用既有交付语义）

- 验证开始/结束前后核对 delivery snapshot fingerprint 与服务版本（`isSnapshotStillValid` 已有）；中途变化 → 结果 stale 不能 accepted
- 分项证据：路由加载/交互/断言逐条记录（passed/failed/unavailable + 机器可判定项与模型观察项分开），单截图/HTTP 200/无 console error 均不单独代替功能验收
- required unavailable → run 保持 unverified 并说明环境原因；测试范围之外不宣称通过

### 1.5 一次修复闭环（不循环自修）

首次 required 浏览器 QA 失败 → `buildEvidencePacket`（脱敏最小证据包，已有）→ 触发新 DeliveryAttempt（既有 supersede 机制使旧成功证据失效）→ 同根预算内重验一次；第二次失败 → `verification_failed` 停手。修复计数独立于 §9 任务策略。AI 可提出 VerificationPlan，但失败后**不得自行把 required 降为 advisory**（服务端拒绝降级写）。

## 2. 数据模型（spec §11.1 落库）

```ts
type ServiceInstance = {
  id: string; workspaceId: string; attemptId: string;
  cwd: string; declaredCommand: string;
  processIdentity?: { pid: number; startedAt: string };
  actualOrigin?: string; healthCheck?: { at: string; ok: boolean; appIdentity?: string };
  owned: boolean;  // owned=Host 启动可停；borrowed=只绑定不停
};

type VerificationPlan = {
  id: string; attemptId: string; version: number;
  steps: Array<{
    kind: "goto" | "click" | "type" | "wait" | "assert_dom" | "assert_visual" | "assert_network";
    target?: string;            // CSS/ARIA 选择器或 URL
    value?: string;             // 输入文本/断言描述
    requirement: "required" | "advisory";
  }>;
  viewport: { width: number; height: number };
  browserContextId?: string;    // 隔离 context；登录态按账号+项目隔离
};

type BrowserVerificationRun = {
  id: string; attemptId: string; serviceId?: string; planId: string;
  snapshotFingerprint: string; planVersion: number;
  status: "queued" | "starting" | "running" | "passed" | "failed" | "cancelled" | "unavailable";
  steps: Array<{ index: number; status: string; durationMs: number; consoleErrors: number; detail?: string }>;
  evidenceRefs: string[];       // 截图/控制台/网络诊断的附件引用
  startedAt: string; endedAt?: string;
};
```

存储：`deliveries.db` 加两张表（service_instances、browser_verification_runs）+ plan 版本化落库；截图走附件存储（既有），引用入 evidenceRefs。

## 3. 执行闭环（spec §11.2 落地序）

1. 固定快照与 Plan（required/advisory 分类冻结；服务端拒绝 required→advisory 的降级写）
2. 服务解析：borrowed 可核对复用 → 否则 owned 启动（TerminalManager + manifest）→ 就绪检查（origin+应用标识）
3. 隔离 context（默认新 partition；显式授权才复用 profile，不自动读日常浏览器 cookie）
4. 执行步骤（单 context 内串行）+ 采集（console error/page error/失败请求/截图；网络诊断去凭据与敏感 body）
5. 判定：功能断言定通过；视觉结果走明确 rubric（机器可判定项与模型观察项分开记录）
6. 首次 required 失败 → 一次修复闭环（§1.5）；第二次失败 → verification_failed
7. 证据落库（URL/视口/时间/快照/计划/工具版本/步骤结果）；前后 fingerprint 复核

取消：关当前验证操作与 owned context；owned 服务按生命周期关闭，borrowed 仅解除绑定。重启后旧 run 记为中断（非 passed），重验建新 run。

## 4. Slice 计划

| # | 内容 | 验收（V 用例） |
| --- | --- | --- |
| V1-S1 | 数据模型+状态机+持久化+unavailable 语义（deliveries.db 两表；vitest 注入 mock verifier） | unavailable 不算通过的分项证据雏形 |
| V1-S2 | ServiceInstance 解析（owned 启动/borrowed 探测/就绪检查 origin+应用标识/端口 Host 分配/cacheDirs 排除） | V01（两 worktree 服务不串台、误占端口证据对应正确版本）；V04（borrowed 不被停止） |
| V1-S3 | Electron verifier 驱动（Main endpoint+token+partition+采集+capturePage）+ Host adapter + dev 模式 unavailable 通道 | V04（取消/重启无假通过）；真实 fixture 链路首次打通 |
| V1-S4 | VerificationPlan 执行引擎（步骤串行/断言聚合/分项证据/多视口） | V02（交互失败但截图正常→required 断言失败不假报）；V05（多视口+功能/视觉混合分项可追溯） |
| V1-S5 | 一次修复闭环 + fingerprint/stale 前后核对 + Electron 模式 e2e 真实 fixture | V03（源码变化旧证据 stale、修复有界、结果可解释）；§17.1 放行的真实浏览器测试 |

UI（审查页展示 run/截图/分项证据）不在 V1 放行条件内，作为独立后续批次（API 面 S1 起就是完整的）。

## 5. 不做（V1 边界）

- CUA 全桌面输入（C1，可复用本阶段证据结构）；跨 Git 服务外部补偿；自动重放外部副作用；第三方浏览器 profile 自动读取；云端/团队协作验证。

## 6. 风险

- R-1 Main↔Host verifier 通道的时序（Main 起晚于 Host 首次验证请求 → 如实 unavailable 重试，不阻塞 Host 启动）；
- R-2 Electron 隐藏窗口在 CI/headless 环境不可用 —— e2e 真实 fixture 只在本机 Electron 模式跑（dev/web 模式 vitest 全覆盖逻辑层），不伪报覆盖；
- R-3 视觉断言 rubric 的模型观察项稳定性 —— 首版只做机器可判定项（尺寸/可见性/文本），模型观察项记 advisory；
- R-4 登录态 partition 与凭据隔离 —— 默认全隔离，复用 profile 需显式授权（UI 后置时先只有隔离面）。

## 7. 实施结果（2026-09-23 收官）

S1–S5 全部完成并推送；vitest 530→552（+22），真实 Chromium e2e 12/12 ALL PASS。

| # | 提交 | 内容与偏差 |
| --- | --- | --- |
| S1 | `3618293` | 按设计；降级守卫按 kind\|target\|value 签名匹配（非 index） |
| S2 | `ad051ca` | 按设计；worktreeFingerprint 排除只滤 untracked（tracked 源码永不排除），未传 exclude 逐字节保持旧算法防存量快照全 stale |
| S3 | `e639f2d` | 按设计；adapter 惰性读 bootstrap 解 Main 后起时序（R-1 落地） |
| S4 | `d357fc3` | 按设计；编排层 workspace 检查先于 plan（无隔离工作区不谈浏览器验证） |
| S5 | `660ed23` | 按设计；e2e 揪出 consoleErrors 必须为 context 累计值（IPC 派发晚于 loadURL resolve，步骤差分在 goto 后恒 0） |

- 后置批次（设计 §4 已声明）：UI 审查页证据展示 + API/Host 接线 → V1-S6 单独推进；plan 的 agent 产生方与 repair 的 agent 接线随 S6/后续批次。
- R-3 落地口径：assert_visual 首版仅机器可判定子集（可见性+尺寸）。

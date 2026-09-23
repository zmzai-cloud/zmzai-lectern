# C1 设计：macOS Computer Use（桌面控制）

- 日期：2026-09-23；状态：实施中（用户指令「继续完成后续任务，截止到 computer use，然后发版」）
- 对应规格：§12 全节、§16 C01–C04、§17.1 C1 行（放行=C01–C04 + 原生 macOS 实测）
- 前置：B0（Host/命令/事件协议）；V1（借用证据结构：分项步骤/证据引用/unavailable 语义）
- 硬边界：**仅 macOS**（Windows capability unavailable 如实报）；API/CLI/结构化浏览器能做的不用 CUA；本期不做输入来源识别（识别不到就不能宣称支持可靠自动接管）

## 1. 总体决策

### 1.1 镜像 V1：broker 纯逻辑 + 注入 adapter（spec §12.1）

ComputerUseBroker 状态机（lease/observation/action/接管/停止）全部在 lib/ 纯 Node 层（vitest 全覆盖）；平台 adapter 注入。**macOS adapter = osascript（System Events/AppleScript）+ screencapture**，零新依赖——不引 native 模块（AXUIElement 绑定/构建链不进本期）。

### 1.2 执行进程 = Next（与 deliveries 同侧）

动作日志与证据进 DeliveryAttempt（deliveries 库在 Next 侧）——与 V1-S6 同判：跨进程双库裂脑。osascript/screencapture 是子进程调用，Next 进程即可执行。

### 1.3 权限与能力真实（C01）

- capability 探测：`osascript` AX 探测（Accessibility 授权）+ `screencapture` 探测（屏幕录制授权）分开报，缺失给具体系统设置路径；探测失败=unavailable 不绕过不假报
- Windows：process.platform 判定 → adapter 直接 unavailable
- 敏感面：截图默认不采集；动作日志只记动作与结果（坐标/键入字符脱敏——键入值不落库）

## 2. 契约（spec §12.2 落地）

```ts
type ControlSession = {
  leaseId: string; rootTaskId: string; hostInstanceId: string;
  targetApp: string; windowId?: string;
  /** 权限范围（本期：observe/click/type/scroll；无 send/upload 等危险面）。 */
  capabilities: string[];
  revision: number; status: "active" | "paused" | "revoked";
  acquiredAt: string;
};

type Observation = {
  observationId: string; at: string;
  windowIdentity: { app: string; windowTitle: string; windowId?: string };
  display?: string; scale?: number;
  /** 可用 accessibility 元数据摘要（元素树按需取，不整树进模型）。 */
  axSummary?: string;
};

type CuaAction = {
  id: string; leaseId: string; observationId: string;
  kind: "click" | "type" | "key" | "scroll" | "read_text";
  target?: string; valueMasked?: string;
  status: "accepted" | "executing" | "succeeded" | "failed" | "unknown";
  detail?: string; at: string;
};
```

- **Observation TTL 5s**（adapter 可收紧）：action 引用的 observationId 过期/revision 不符/窗口身份变化 → 拒绝（C02），必须重新观察
- **全桌面单 lease**：broker 内一个活动 lease，按 rootTaskId 排队；新任务抢 lease = 前租约 revoke（C03）
- **每动作后观察效果**由调用方编排（agent 循环后续接）；本期不执行不经中间核验的长串坐标脚本（一次 API = 一个动作）
- **unknown ≠ 可重试**：结果无法确认的动作登记 unknown，broker 拒绝对同 (leaseId, observationId, kind, target) 的盲目重试——需新观察后新动作（C04）
- **紧急停止**：stop API 清队列撤销 lease（排队旧动作不执行）；**用户接管**：takeover API → lease paused，恢复需显式 resume；adapter 层键鼠由 osascript 单步执行，无持续注入（无「释放键盘」问题，接管语义=broker 停发）
- 崩溃/锁屏/目标退出：adapter 动作失败分类（app-exit/permission-revoked/screen-locked）→ broker 撤 lease 不复用旧队列

## 3. Slice 计划

| # | 内容 | 验收 |
| --- | --- | --- |
| C1-S1 | broker 纯逻辑 + adapter 接口 + 动作日志持久化（deliveries.db cua_actions 表） | C02/C03/C04 全逻辑分支 |
| C1-S2 | macOS adapter（osascript 窗口/AX click/type/key/scroll + read_text + screencapture 可选）+ 权限探测 | C01（探测/引导/unavailable） |
| C1-S3 | Next API（capability/observe/act/stop/takeover/status）+ 证据进 attempt（脱敏 CommandRun）+ UI 常驻控制条与停止入口 + 全局快捷键 | C03（停止后不执行排队动作）API 面 |
| C1-S4 | 原生 macOS 实测脚本（Calculator 真点击读数；权限缺失诚实降级 exit 2=未验证不伪报） | C01–C04 原生实测 |

## 4. 不做（C1 边界）

- Windows adapter（capability unavailable）；视觉坐标点击（仅 AX 结构化定位——osascript by name/description，不做截图找坐标）；拖拽；输入来源识别；发送/上传类动作面；凭据场景自动输入（密码/验证码一律用户接管）。

## 5. 风险

- R-1 osascript AX 枚举慢（整树秒级）——observation 只取窗口身份+按需单元素，不整树；
- R-2 TCC 授权主体是父应用（终端/打包后的 app）——探测按实际执行主体如实报；
- R-3 本机无 Accessibility 授权时原生实测不可跑——脚本 exit 2 标未验证（不伪报），待真机授权后补验。

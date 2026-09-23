# W1 设计：任务 worktree 全生命周期（B0 后首个扩展阶段）

- 日期：2026-09-23；状态：设计稿，供 review 后实施
- 对应规格：§10 全节（创建/环境准备/审查整合/生命周期）、§17.1 W1 行
- 前置：B0 收官（0.9.0）；spec §10 点名的四宗罪现状（创建失败降级、映射落库失败仍报成功、merge 跟随主目录当前分支、清理不查返回值）在 M2b 已由 fixture 验证复现过路径
- 硬边界：单任务 worktree 全生命周期 + 多根任务各自 worktree；**不做**子代理多 worktree 自动合并（spec 明示）

## 1. 总体决策

### 1.1 WorkspaceService 在 Lectern Host（非 framework）

worktree 是 Git + 文件系统 + 项目注册的复合操作，依赖 Lectern 的 projects/worktree.db/交付门禁——放 Host 进程（`lib/workspace-service.ts`），framework 不动。子代理写权冲突判定继续走 session 队列（B0 现状），W1 只加 worktree 维度。

### 1.2 WorktreeRecord 与状态机（spec §10.1）

```ts
type WorktreeState = "creating" | "preparing" | "ready" | "active" | "verifying"
  | "ready_for_review" | "integrating" | "integrated" | "archived" | "deleting" | "failed";

type WorktreeRecord = {
  workspaceId: string; projectId: string; repoIdentity: string;
  sessionId: string; rootTaskId: string;
  baseRef: string; baseCommit: string; targetRef: string;
  path: string; branch: string;
  startingState: "current_commit" | "specified_ref" | "working_tree_snapshot";
  state: WorktreeState; prepareResult?: unknown; activeOperation?: string; revision: number;
  times: { createdAt: string; readyAt?: string; integratedAt?: string };
};
```

沿用现有 worktrees.db 但 schema 升版本（旧记录迁移：补 state=archived/unknown 归档态，不猜活跃）。

### 1.3 四宗罪的修复对策（spec §10 逐条）

| 现状罪 | 修复 |
| --- | --- |
| 创建失败降级继续 | `creating` 先持久登记（含操作 ID）→ Git 操作 → 映射落库 → **二者核对一致才 ready**；失败保持 `failed` 可重试，不自动落回主工作区 |
| 映射落库失败仍报成功 | 落库在同一事务窗口内做核对读（写后读回比对）；不一致 → failed + 清理刚建的 Git worktree |
| merge 跟随主目录当前分支 | `baseCommit`/`targetRef` 创建时固定；整合前 CAS 校验 `expectedTargetCommit` |
| 清理不查返回值 | 删除序列每步查返回码，任一失败保留 `deleting` 可修复记录 |

### 1.4 整合（spec §10.3 核心安全）

- 整合前：停源工作区写入 + repository 级整合锁 + 核对 targetRef/expectedTargetCommit/源快照/目标 clean；
- **受管临时整合 worktree** 上做合并（不污染源与目标）；冲突保留为独立 integration attempt，修复后**对实际合并结果重新验证**；
- 目标已 checkout → fast-forward only（clean + HEAD/ref 未变化，失败不强推）；目标未 checkout → expectedTargetCommit CAS update-ref；
- integration journal 每步落库；重试先判「目标是否已含预期整合提交」（不重复合并）；中断后对账 ref/index/tree/journal，未知保持 blocked。

### 1.5 交付门禁对接

现有 `lib/delivery.ts` 的 git CAS 合并与 WorkspaceService 的整合**收敛为同一实现**：delivery 调 WorkspaceService.integrate（带 evidence 约束），旧直接 merge 接口下线——M2b 遗留的"两套合并并存"问题就此清偿。

## 2. Slice 计划

| # | 内容 | 验收（W 用例） |
| --- | --- | --- |
| S23 | WorkspaceService 骨架 + WorktreeRecord schema 迁移 + 创建序列（登记→Git→核对→ready/failed） | W01 三种起点（dirty/untracked 排除预览）；W02 落库失败/重启对账/不接管同名分支 |
| S24 | 环境准备（setup manifest：依赖安装走工具权限、端口 Host 分配、配置映射不进模型上下文） | W03 准备失败真实状态/可取消/资源独立 |
| S25 | 审查快照（内容 fingerprint + Git tree 标识）+ 证据绑定 | 与 M2b 交付证据链对接 |
| S26 | 整合序列（锁/CAS/受管 worktree 合并/FF-only/journal/重试对账） | W04 目标推进/dirty 拒绝；W05 冲突/中断重试不重复整合 |
| S27 | 生命周期收尾（接受不删目录/integrated 归档/删除序列查返回值）+ 旧 merge 接口收敛 + 路由网关化 | W06 不悄悄换工作区/不误删/可修复记录 |

## 3. 不做（W1 边界）

- 子代理多 worktree 自动整合（spec §1.2 明示）；跨 Git 服务的外部补偿；worktree 内再嵌 worktree。

## 4. 风险

- R-1 整合序列的 FF-only 与现有交付 CAS 的语义合并——S26 单独一轮，先事务图；
- R-2 旧 worktrees.db 迁移的未知态记录——按 archived 处理并在 UI 可见，不猜；
- R-3 Windows 路径/盘符差异的 Git 行为（本机不可验证）——代码按 path 库写，真机验证标未验证。

## 5. 实施结果（2026-09-23 收官）

S23–S27 全部完成并推送；测试 504→520（+16），typecheck 0。

| # | 提交 | 内容与偏差 |
| --- | --- | --- |
| S23 | `bfcf8c9` | 按设计；实测发现第五宗罪：worktree add -b 缺 baseCommit 起点则 specified_ref 静默从 HEAD 建分支，已修 |
| S24 | `fe0752a` | 按设计；命令经宿主注入执行器走 bash 工具权限链 |
| S25 | `a659e5a` | 按设计；指纹=sha256(headCommit+porcelain+文件内容摘要) |
| S26 | `9bcf427` | 按设计；容器目录须进 .git/info/exclude（否则目标 clean 检查被自身 worktree 卡死）；未 checkout 路径 update-ref 前必须后代校验 |
| S27 | `0d0fac3`/`3d88f5b`/`69fb7b1` | 三刀：A=多轮交付锚点（integrationSource 四象限去重）+sourceCommit 覆盖+归档+旧表导入+读面双读；B=写路径收敛（workspace-actions 动作层+mergeAttemptCas 委托 integrate+三路由切换，两套合并并存清偿）；C=Host POST worktree+网关表 |

- markReadyForReview 为实施中新增的审查态入口（整合门槛 ready_for_review 的正规转移）；
- delivery snapshot 扩展 targetHeadSha（verify 时目标锚点，接受时目标推进→拒绝）；
- 旧 lib/worktree.ts 保留只读双读面（workspace_records 优先/旧表 fallback），写函数无生产调用者。

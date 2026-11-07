# P0 构建修复与阻塞评测执行记录

依据：`2026-09-28-production-chain-closure-plan.md` T12/T20；
`2026-11-04-p0-progress.md` 后续任务。用户已授权执行，模型指定 glm-5.3-flash。

## 执行边界

本批先完成构建诊断与缺信息恢复的消费层实测；剩余路由迁移、子代理、
浏览器/CUA 原生验收继续按原收口计划追踪，不因本批通过而关闭整个 P0。

### Task 1: 构建目录循环

- [x] 检查 OOM 堆栈和发布脚本：历史正常构建约 12 分钟，10 分钟中止不代表卡死。
- [x] 隔离 worktree 重现，记录 readdir 计数与 Node 堆。
- [x] 定位本地 node_modules/node_modules 自引用软链接，记录目标到本地忽略的 .superpowers/p0-build/ 后移除链接；未删除依赖目标。
- [x] 最小变量复测：不改源码，6GB 堆构建退出 0，编译约 2.5 分钟。
- [x] 新增自引用检测测试，先观察模块不存在的 RED，再实现前置检查并 GREEN。
- [x] 新增 runtimeWorkspacePath，阻止 NFT 将动态 worktree 路径作为构建资产递归扫描；实际运行仍调用 path.resolve。
- [x] 独立依赖目录安装，避免 worktree 共享软链接导致 standalone 越界追踪。
- [x] 全量测试、发布检查和两轮独立代码审查；最终构建与产物清洁检查见下方验证。

Files: scripts/check-dependency-layout{,.test}.mjs、scripts/runtime-path-tracing.test.mjs、
lib/runtime-workspace-path.ts、lib/worktree.ts、lib/workspace-service.ts、lib/session-owner.ts、package.json。
入口 checkDependencyLayout(root)：拒绝依赖根的嵌套自引用；保留正常工作区和包链接。
前置检查只识别该种自引用，不保证发现任意深层软链接环。追踪回归使用 esbuild fixture，
生产行为仍以实际 Next 构建为准；插件目录等其他动态路径的扫描放大仍可观察到，不能声称构建耗时已优化完毕。

### Task 2: 缺信息与同任务恢复

- [x] 扩展既有消费层执行器，新增 P0-BLOCK-INPUT；默认仍只跑原 9 个编码样本。
- [x] 显式配置 LECTERN_EVAL_CASES 只运行新增场景。
- [x] 三轮各三次真实调用；前两轮观察到 waiting_input/input + 成功 task_block、补信息后同 taskId 恢复。
- [x] 核对文件断言、保护文件、状态和原始结果，归档并记录局限。
- [ ] 明确格式与新增补信息前边界检查下三次均交付；最新一轮上游不可用，不能据此关闭。

Files: evals/harness/coding-baseline.ts、evals/results/。
场景：approvals.json 缺审批码 → 等用户输入 → 写 receipt.txt；禁止编造或改源配置。
详见 evals/results/2026-11-04-glm-block-input.md；三轮协议存在变化，不合并成功率。

### Task 3: 会话创建 Host 迁移

- [x] 将创建业务抽成标准 Request/Response 服务，Next armed 请求经 /v1/session-create 执行。
- [x] 在网关入口固定 projectId，跨异步读取与模型解析不切换项目；未知项目返回 404。
- [x] 保留 requestId 幂等、冲突检测、隔离副本失败状态和 legacy 启动模式。
- [x] Host 授权校验后传递完整业务 cookie，bootstrap authorization 不进入业务服务。
- [x] 审查发现 cookie 重复前缀；用实际完整 cookie 构造回归观察 RED，修复后 GREEN。
- [ ] PATCH/DELETE 及其他路由迁移仍待后续执行。

Files: lib/session-create-service.ts、app/api/sessions/route.ts、lib/host-gateway.ts、
host/src/{server,real-runtime}.ts 与对应回归测试。归属清单同步更新。

## 本批验证

- pnpm test：72 文件、656 通过、1 个原生授权用例跳过；未声称已跑原生权限验收。
- pnpm test:release：111 通过，包括新依赖布局和 NFT 路径回归。
- pnpm typecheck、pnpm arch:check、pnpm host:build：退出 0；架构仍有 21 条过渡豁免。
- 三份缺信息评测 JSON：通过 results.schema.json；执行器 esbuild 编译通过。
- git diff --check：通过。
- 最终独立依赖目录下生产构建：6GB 堆上限退出 0，编译 7.2 分钟；不以较早共享依赖构建通过代替最终产物验证。
- node scripts/check-standalone-clean.mjs：退出 0，产物无本机数据，追踪图无越界或源码目录指向。

## 审查处置

- 额外文件导致假通过：已新增全工作区路径检查与两个回归测试。
- 补信息前可能提前写占位输出：已新增输入不变和不得产生输出的边界检查；真实复测待上游恢复。
- Host cookie 重复前缀：已修复，有 RED/GREEN 回归。
- runtime 路径归一化和会话归属：独立审查未发现重要缺陷，真实构建仍需验证。
- 次要问题：输出断言 trim 误接收首尾空白，合成文件检查 RED/GREEN 后改为严格匹配；尚无新真实模型复测。

## 决策

- Ruling: 原生 worktree 工具长期无返回后终止编排，使用 git worktree 回退。
  隔离路径为 .worktrees/p0-build-closure，分支 feat/p0-build-closure；代价是没有原生附件注册。
- Ruling: 初期 node_modules 与原 checkout 共用，只移除确认的递归软链接，不删除依赖目标。
  最终 worktree 使用 pnpm 离线锁定安装的独立依赖；链接备份改为目标文本，避免扫描备份时再次递归。
  代价是其他使用原依赖目录的构建也会看到已修复布局。
- Ruling: 先做真实缺信息场景，不将成功编码任务 task_block=0 解释为漏调用。

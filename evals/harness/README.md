# P0 执行入口

## 真实会话统计

`pnpm eval:contracts <LECTERN_DATA_DIR>`

只读打开默认库及 `projects/*/zmzai.db`，从最终消息 part 计数，不累计重复事件。
输出不含会话 ID、路径、文件名、正文或凭据。旧库记 unsupported_schema。
“possibleMissingBlockMessages”仅是需人工复核的文本线索，不能作为任务状态或漏调用率。
任务归属按根消息和创建时间推导，不能替代逐 Attempt 的实验记录。

## 隔离编码基线

```sh
LECTERN_EVAL_MODEL=<model-id> pnpm eval:coding
```

端点和凭据从 OPENAI_BASE_URL/OPENAI_API_KEY 或现有 Lectern settings 获取；
数据目录可通过 LECTERN_DATA_DIR 指向已配置的 profile。命令不会打印凭据。
默认 3 个案例（R02、R03、R08）各 3 次，串行，单次最多 6 Attempt、120 秒运行预算、
每次模型输出最多 2048 token，130 秒外部看门狗。费用不可得时记录 null。
工作区使用临时目录；禁用 shell、网络和子代理工具。判分在模型工作区之外由固定断言执行。

结果写 `test-results/p0-evals/coding-baseline.json`，未运行或失败均退出非零。
缺连接配置时记录 not_run，不能当作模型失败或验收成功。
这是安装后的 Framework 消费层基线；未覆盖 Host、浏览器、worktree 合并和记忆。
生产链路 PC22 的六类任务和竞品对照仍需另跑，不能用此小套件替代。

新增缺信息恢复场景：`LECTERN_EVAL_CASES=P0-BLOCK-INPUT`，仍为三次隔离运行。
要求模型首先成功调用 task_block 并进入 waiting_input/input，执行器补充合成审批码后，
必须保持同一 taskId、正确写入 receipt.txt、保持 approvals.json 不变并最终 delivered。
补充输入属于测试脚本预定交互，不代表全程无需用户提供信息。

## PC22 真实产品链路评测（Host 驱动）

```sh
LECTERN_EVAL_COOKIE="muzhi_session=…" node evals/harness/pc22-host-runner.mjs [--samples 3] [--cases A,B]
node evals/harness/pc22-host-runner.mjs --dry-run            # 不调模型，只验证管线
node evals/harness/pc22-host-runner.mjs --label before --host-bundle <旧版 host/dist/host/src/index.js>
```

驱动**打包 Host 进程**（隔离临时数据目录），走 Lectern 真实 runtime 与全部工具
（终端、git、子代理、browser_verify、computer_use 等）。六类：跨文件修改、失败测试修复、
双子代理探索整合、worktree 合并后回归（合并时实跑 `.lectern/verification.json`）、
浏览器表单验收（模型须调用 browser_verify，执行器另用真实 Chromium 独立复验）、
项目记忆重复任务（无授权测试 bank 时记 blocked）；另含 P0-BLOCK-INPUT。
凭据只经内存（`x-lectern-credential` 头），不落盘、不进结果。浏览器类需 Electron 驱动
（ELECTRON_BIN 或本仓库/主 checkout 的 node_modules/electron）。

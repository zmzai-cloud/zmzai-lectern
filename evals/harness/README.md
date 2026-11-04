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

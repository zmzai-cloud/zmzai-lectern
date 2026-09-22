# 评测 fixture 规划

每个 fixture 是独立 git 仓库，固定 commit 供案例引用；harness 每次运行前 reset 到该 commit。禁止在用户实际项目上做基准写入。

| fixture | 服务案例 | 内容 | 状态 |
| --- | --- | --- | --- |
| fx-understanding | R01 / R10 | 小型 TS 服务（路由/数据流/配置三层），附不随 fixture 分发的隐藏问答答案 | planned |
| fx-multifile-bug | R02 / R06 / R07 / R09 / R11 | 跨 3 模块缺陷 + npm test 红；R06/R07/R09/R11 为其变体 | planned |
| fx-failing-tests | R03 | 预置失败测试（正确行为已在但断言失败） | planned |
| fx-attachment-spec | R04 | 约束文档以附件形式输入 | planned |
| fx-long-context | R05 | 长历史生成脚本（deterministic 生成，非模型生成） | planned |
| fx-tool-errors | R08 | 诱导路径/参数错误的任务场景 | planned |
| fx-integration | R12 | 两个可独立完成的子任务 + 整合测试 | planned |
| echo-mcp-server | A 类 | 已有：`e2e/fixtures/echo-mcp-server.mjs` | ready |

构建顺序建议：fx-multifile-bug → fx-failing-tests → fx-understanding（这三个覆盖 R02/R03/R01 即可开跑 B0 真实模型基线的前半），其余随 harness 层级到位补齐。

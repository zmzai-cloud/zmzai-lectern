# ADR：M1–M2 开发期 Framework 联调方式

- 日期：2026-09-21；状态：**已验证并落地**（原定 `pnpm link` 方案经验证否决，改用 `file:` 目录依赖）
- 对应规格：§17.0「Framework 联调」、§15.7
- 工具：`scripts/framework-dev.sh on|off`

## 验证记录（2026-09-21，Node 26.2.0 / pnpm 10.34.5）

| 模式 | 解析位置 | vitest | 结论 |
| --- | --- | --- | --- |
| vendor tarball（`file:vendor/*.tgz`） | .pnpm store | 43/43 文件，484/484 测试 ✅ | 基线 |
| `pnpm link ../zmzai-framework` | symlink 直指兄弟目录 | 7 文件加载失败（`Failed to load url sqlite`），仅 413 测试可跑 | ❌ 否决 |
| `file:../zmzai-framework`（目录依赖） | .pnpm store | 43/43 文件，484/484 测试 ✅ | ✅ 采用 |

`pnpm link` 否决理由（两条都致命）：

1. 它不是 node_modules 级操作——会向 `package.json` 注入 `pnpm.overrides."@zmzai/agent-framework": "link:../zmzai-framework"`，并把 `pnpm-lock.yaml` 删减 882 行；事后 `pnpm install` 不会恢复 link 前状态，必须 git 还原两个文件。
2. `link:` 解析使包位于 node_modules 之外，vitest 不再对其 externalize，framework dist 里 `node:sqlite` 的导入经 vite 转换解析为裸 `sqlite` 失败——7 个附件提取测试文件无法加载。

`file:` 目录依赖进 .pnpm store，与 tarball 同等 externalize 语义，测试行为与基线完全一致；代价是 Framework 重建后需 `pnpm install`（实测约 7s）刷新拷贝。

## 使用方式与纪律

```bash
scripts/framework-dev.sh on     # 切到 file:../zmzai-framework（先 pnpm --dir ../zmzai-framework build）
# 改 Framework 源码 → build → pnpm install 刷新，循环
scripts/framework-dev.sh off    # git 还原 package.json/lock + 切回 vendor tarball
```

- on 状态禁止提交 `package.json` / `pnpm-lock.yaml`、禁止出 release、禁止打 tag。
- 里程碑边界（M1 收口、M2c、M4、各扩展阶段收口）必须 off，并回归 tarball 流程：framework 仓 `pnpm build && npm pack --pack-destination ../zmzai-lectern/vendor`，bump file: 版本号，`pnpm install --lockfile-only`。
- CI 双 lane：联调 lane 允许 file: 目录依赖；发布/打包 lane 只认 vendor tarball + lockfile integrity。

## 附带修正（本次已落地）

- `vendor/README.md` 版本号 0.5.1 → 0.9.0（原文档漂移），"version adds" 章节改标为历史记录，补充本 ADR 指引。
- `dev:fresh` 中的 `framework:build` 在 tarball 依赖下不刷新 node_modules，确认为失效步骤（file: 目录模式下也需 install 才生效）；建议随 M1 首个提交把它改造成 `framework-dev.sh on` 或删除。

## 基线快照

2026-09-21，tarball@0.9.0：**vitest 43 文件 / 484 测试全绿**。这是 M1「行为保持」的对照基准——M1 期间任何拆分步骤之后必须回到同一绿色水平（联调 on/off 两种模式下均是）。

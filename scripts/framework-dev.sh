#!/usr/bin/env bash
# Framework 联调开关（ADR: docs/superpowers/plans/2026-09-21-framework-dev-linking-adr.md）
# on  —— 依赖切到 file:../zmzai-framework（进 .pnpm store，vitest 语义与 tarball 一致）
# off —— git 还原 package.json/pnpm-lock.yaml 并切回 vendor tarball
# 注意：改 Framework 源码后需先 pnpm --dir ../zmzai-framework build，再 pnpm install（或重跑本脚本 on）刷新拷贝。
# 禁止在 on 状态提交 package.json / pnpm-lock.yaml、出 release 或打 tag。
set -euo pipefail

case "${1:-}" in
  on)
    pnpm pkg set 'dependencies.@zmzai/agent-framework=file:../zmzai-framework'
    pnpm install >/dev/null
    echo "✅ 已切到 file:../zmzai-framework（提交/发版前必须 off）"
    ;;
  off)
    git checkout -- package.json pnpm-lock.yaml
    pnpm install >/dev/null
    echo "✅ 已切回 vendor tarball"
    ;;
  *)
    echo "用法: scripts/framework-dev.sh on|off" >&2
    exit 1
    ;;
esac

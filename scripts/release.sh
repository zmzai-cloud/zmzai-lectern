#!/usr/bin/env bash
# 兼容入口：完整双平台发布已收敛到 Node 编排器。
# 用法见 `node scripts/release-desktop.mjs --help`。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/release-desktop.mjs "$@"

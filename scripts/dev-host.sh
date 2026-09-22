#!/usr/bin/env bash
# M2c-S13：dev 拓扑一键（Host + armed next dev）。
# 用法：scripts/dev-host.sh [dataDir]；数据目录缺省 <repo>/.host-dev-data。
# 退出（Ctrl-C）时进程组整体收尾——Host SIGTERM → lock 清理。
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${1:-$PWD/.host-dev-data}"
mkdir -p "$DATA"
HOST_LOG="$DATA/host-stdout.log"

pnpm host:build >/dev/null
echo "[dev-host] 启动 Host（数据目录 $DATA）"
LECTERN_HOST_DATA="$DATA" LECTERN_WORKSPACE="$DATA/workspace" \
  node host/dist/host/src/index.js >"$HOST_LOG" 2>&1 &
HOST_PID=$!
trap 'kill -TERM -$HOST_PID 2>/dev/null || kill -TERM $HOST_PID 2>/dev/null; exit 0' INT TERM EXIT
sleep 1
if ! kill -0 "$HOST_PID" 2>/dev/null; then
  echo "[dev-host] Host 启动失败（详见 $HOST_LOG）："; cat "$HOST_LOG"; exit 1
fi
echo "[dev-host] Host 就绪：$(cat "$DATA/host.json" | head -c 200)"
echo "[dev-host] 启动 next dev（网关 armed → Host）"
LECTERN_HOST_GATEWAY="$DATA/host.json" LECTERN_HOST_BOOTSTRAP="$DATA/host.json" \
  pnpm dev:web

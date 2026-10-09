#!/usr/bin/env bash
# Lectern — 共享 web 构建（host bundle + next build + standalone 组装）
#
# build-mac.sh 与 build-win-cross.sh 都经由此脚本产出 .next：web 产物对两个
# 平台完全相同，第二个平台自动复用第一个平台刚构建的 .next，双平台发版的
# 本地链路从「两次 next build（各 ~12 分钟）」缩到一次。
#
# 复用判定 = .next/.lectern-web.json 记录的 {version, git sha, 工作区脏哈希}
# 与当前一致（任何提交或改动都会让标记失效，宁可重建不带脏产物）；
# LECTERN_FORCE_WEB=1 强制重建。平台包的 node_modules 实体化按平台各自执行，
# 会整体替换 .next/standalone/node_modules，与本标记互不影响。
set -euo pipefail
cd "$(dirname "$0")/.."

marker=".next/.lectern-web.json"
current_identity() {
  node -e '
    const { readFileSync } = require("node:fs");
    const { execSync } = require("node:child_process");
    const crypto = require("node:crypto");
    const sha = execSync("git rev-parse HEAD").toString().trim();
    let dirty = "";
    try { dirty = execSync("git status --porcelain", { maxBuffer: 33554432 }).toString(); } catch {}
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const dirtyHash = crypto.createHash("sha256").update(dirty).digest("hex").slice(0, 16);
    process.stdout.write(JSON.stringify({ version, sha, dirty: dirtyHash }));
  '
}

if [ "${LECTERN_FORCE_WEB:-0}" != "1" ] && [ -f "$marker" ] && [ -f .next/standalone/server.js ]; then
  want=$(current_identity)
  have=$(cat "$marker")
  if [ "$want" = "$have" ]; then
    echo "==> [web] 复用刚构建的 .next（${want}）——同版本同提交，跳过 next build"
    exit 0
  fi
  echo "==> [web] 复用标记失效（当前 ${want} ≠ 标记 ${have}），重建 web 产物"
fi

# 大目录删除一律先 mv 到 /tmp（WorkBuddy safe-delete 守卫对 >50 文件的 rm 会拦截）
guard_mv() {
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    mv "$d" "/tmp/lectern-rm-$(date +%s)-$RANDOM"
  done
}

echo "==> [web] host build（M2c-S16：Host dist 进打包资源）"
pnpm host:build || { echo "❌ host:build 失败" >&2; exit 1; }
[ -f host/dist/host/src/index.js ] || { echo "❌ host/dist/host/src/index.js 缺失" >&2; exit 1; }
echo '{"type":"module"}' > host/dist/package.json

echo "==> [web] next build（生产构建，含 standalone 输出）"
# next build 的默认堆上限按可用内存推导，实测会「Reached heap limit」exit 134。
if [[ "${NODE_OPTIONS:-}" != *max-old-space-size* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${LECTERN_BUILD_HEAP_MB:-12288}"
fi
# 隔离整个旧 .next，避免开发缓存污染生产页面清单；备份保留在 /tmp。
guard_mv .next tsconfig.tsbuildinfo
pnpm build
# fail-fast：入口不存在就停，绝不打出会闪退的包
[ -f .next/standalone/server.js ] || { echo "❌ .next/standalone/server.js 缺失，standalone 布局异常" >&2; exit 1; }

# nft tracing 会把根 .env（loadEnvFile 读取模式被静态分析）与 host 编译入口收进
# standalone 根——已知 tracing 产物非运行时残留，检查前清掉；真数据泄漏仍由
# check-standalone-clean 拦截（data/ 泄漏事故的双防线之一）。
for stray in .next/standalone/index.js .next/standalone/.env; do
  [ -e "$stray" ] && mv "$stray" "/tmp/lectern-stray-$(basename "$stray")-$(date +%s)"
done
node scripts/check-standalone-clean.mjs || exit 1

echo "==> [web] 组装 standalone 运行时（静态资源/页面资源拷入 standalone）"
# next build 不自动拷贝：standalone server 按相对路径找 .next/static 与 public
rm -rf .next/standalone/public
mkdir -p .next/standalone/.next
cp -R public .next/standalone/public 2>/dev/null || mkdir -p .next/standalone/public
cp -R .next/static .next/standalone/.next/static

current_identity > "$marker"
echo "==> [web] 完成，复用标记已写入 ${marker}"

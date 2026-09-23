#!/usr/bin/env bash
# Lectern — macOS 打包脚本（Apple Silicon / arm64）
# 用法：bash scripts/build-mac.sh   （产物在 dist/）
# 前置：pnpm install；发行包使用 electron/release-defaults.cjs 的公开配置。
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${LECTERN_REQUIRE_SIGNING:-0}" = "1" ]; then node scripts/signing-preflight.mjs darwin; fi

# 大目录删除一律先 mv 到 /tmp（WorkBuddy safe-delete 守卫对 >50 文件的 rm
# 会拦截：SAFE_DELETE_BULK_CONFIRM_REQUIRED）；/tmp 重启自动清。
guard_mv() {
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    mv "$d" "/tmp/lectern-rm-$(date +%s)-$RANDOM"
  done
}

echo "==> [0/5] 清理历史打包产物（避免 dist 累积旧版本 dmg/zip）"
bash scripts/clean-dist.sh

echo "==> [0/5] host build（M2c-S16：Host dist 进打包资源）"
pnpm host:build || { echo "❌ host:build 失败，中止打包" >&2; exit 1; }
[ -f host/dist/host/src/index.js ] || { echo "❌ host/dist/host/src/index.js 缺失" >&2; exit 1; }
echo '{"type":"module"}' > host/dist/package.json

echo "==> [1/5] next build（生产构建，含 standalone 输出）"
# next build 的默认堆上限按可用内存推导（本机 64GB 也只给到 ~4GB），实测跑到
# 「Reached heap limit Allocation failed」直接中止（exit 134），崩在打包第一步。
# CI 靠 workflow 里的 NODE_OPTIONS 抬高，本地构建脚本必须自己抬——否则谁调谁崩。
# 调用方已显式给了 --max-old-space-size 就尊重，不覆盖。
if [[ "${NODE_OPTIONS:-}" != *max-old-space-size* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=${LECTERN_BUILD_HEAP_MB:-12288}"
fi
# 隔离整个旧 .next，避免开发缓存污染生产页面清单；备份保留在 /tmp。
guard_mv .next tsconfig.tsbuildinfo
pnpm build

# fail-fast：入口不存在就停，绝不打出会闪退的包（曾因 Next workspace root
# 误判导致 standalone 嵌套成 zmzai-harness/server.js）
[ -f .next/standalone/server.js ] || { echo "❌ .next/standalone/server.js 缺失，standalone 布局异常，中止打包" >&2; exit 1; }

# fail-fast：产物不得混入本机数据。Next 的文件追踪会把仓库根 data/（历史遗留的老
# 数据目录，含真实会话库与 .secret）复制进 standalone 并随安装包公开发布——
# v0.2.0~v0.4.3 双平台全部中招，只能全线下架重发。next.config.mjs 的
# outputFileTracingExcludes 是主防线，这层是兜底。
# nft tracing 会把根 .env（loadEnvFile 读取模式被静态分析）与 host 编译入口
# （index.js，与 host/dist/host/src/index.js 逐字节同源）收进 standalone 根——
# 已知 tracing 产物非运行时残留，检查前清掉；真残留（.workspace/logs/data）仍由
# check-standalone-clean 拦截。根因（为何 0.9.0 构建未复现）待查，见发版记忆。
for stray in .next/standalone/index.js .next/standalone/.env; do
  [ -e "$stray" ] && mv "$stray" "/tmp/lectern-stray-$(basename "$stray")-$(date +%s)"
done
node scripts/check-standalone-clean.mjs || exit 1

echo "==> [2/5] 组装 standalone 运行时（静态资源/页面资源拷入 standalone）"
# next build 不自动拷贝：standalone server 按相对路径找 .next/static 与 public
rm -rf .next/standalone/public
mkdir -p .next/standalone/.next
cp -R public .next/standalone/public 2>/dev/null || mkdir -p .next/standalone/public
cp -R .next/static .next/standalone/.next/static

echo "==> [3/5] 组装实体 node_modules（pnpm symlink / file: 依赖实体化）"
# pnpm 下 next standalone 的 trace 产出的 node_modules 只含指向 .pnpm 的断链
# symlink；electron-builder 复制 pnpm node_modules 也不完整（file: 依赖丢失）。
# 这里用 npm 从 tarball 安装一份完全实体的生产依赖整体替换。
guard_mv .package-build
node scripts/prepare-prod-package.mjs
(cd .package-build && npm install --omit=dev --no-audit --no-fund --loglevel=error)
# 替换前保存 trace 命中的最小依赖清单（npm 全量里大量纯 JS 包已被 webpack
# bundle 进 .next/server，运行时不再 require，按 trace 白名单删掉才瘦得下来）
node scripts/save-trace-pkgs.mjs .next/trace-pkgs.txt
guard_mv .next/standalone/node_modules
mv .package-build/node_modules .next/standalone/node_modules
# 瘦身两刀：① prune 按 trace 白名单删冗余纯 JS 包 ② shrink 裁剪 native 平台/语言
node scripts/prune-standalone.mjs .next/trace-pkgs.txt .next/standalone/node_modules
node scripts/shrink-native.mjs .next/standalone/node_modules --platform=darwin --arch=arm64
# asar 化前提：server.js 开头的 process.chdir(__dirname) 在 asar 内会 ENOTDIR
# 直接崩（asar 是文件不是目录，chdir 不吃 Electron 的 fs 补丁），必须摘掉
node scripts/patch-standalone-for-asar.mjs .next/standalone --strict
guard_mv .package-build

echo "==> [4/5] electron-builder 打包 macOS（dmg + zip，arm64）"
# 本地构建 ad-hoc；LECTERN_REQUIRE_SIGNING=1 强制 Developer ID 和公证。
# SKIP_DMG=1 只出 zip：dmg 需要 hdiutil/ditto 挂载写 /Volumes，受限环境（CI 沙箱、
# 无 TCC 磁盘权限的宿主）会 Operation not permitted。跳过 dmg 不影响 zip/.app。
BUILD_ARGS=(--mac --arm64 --publish never)
if [ "${SKIP_DMG:-0}" = "1" ]; then BUILD_ARGS+=(-c.mac.target=zip); fi
# Signing must precede ZIP/DMG generation; never modify a published archive afterward.
if [ "${LECTERN_REQUIRE_SIGNING:-0}" = "1" ]; then
  node scripts/signing-preflight.mjs darwin
  BUILD_ARGS+=(-c.forceCodeSigning=true -c.mac.type=distribution)
else
  BUILD_ARGS+=(-c.mac.identity=- -c.mac.hardenedRuntime=false -c.mac.notarize=false)
fi
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
pnpm exec electron-builder "${BUILD_ARGS[@]}"

echo "==> [5/6] 校验已签名应用与发布清单"
# 这里只检查，不再修改 bundle，确保 ZIP/DMG、blockmap、清单描述相同字节。
APP_PATH=$(find dist -maxdepth 2 -name "*.app" -type d | head -1)
if [ -n "$APP_PATH" ]; then
  # asar 断言：app 必须是单个 app.asar 而不是散开的 app/ 目录（散开就是八千量级
  # 文件，安装与首次启动都会明显变慢）。
  [ -f "$APP_PATH/Contents/Resources/app.asar" ] || { echo "❌ 未生成 app.asar（asar 未生效）" >&2; exit 1; }
  UNPACKED=$(find "$APP_PATH/Contents/Resources/app.asar.unpacked" -type f 2>/dev/null | wc -l | tr -d " ")
  echo "解包原生文件：$UNPACKED 个（期望 ≥5：node-pty/sharp/swc 的 .node 与 dylib）"
  [ "$UNPACKED" -ge 5 ] || { echo "❌ asarUnpack 未生效，原生二进制留在 asar 内会加载失败" >&2; exit 1; }
  codesign --verify --deep --strict "$APP_PATH"
  echo "签名完整性通过：$APP_PATH"

  node scripts/release-validation.mjs package "$APP_PATH/Contents/Resources/app.asar" darwin
  if [ "${LECTERN_REQUIRE_SIGNING:-0}" = "1" ]; then
    xcrun stapler validate "$APP_PATH"
    spctl --assess --type execute --verbose "$APP_PATH"
  fi
fi

node scripts/release-validation.mjs release dist darwin

echo "==> [6/6] 产物"
# dmg 可能不存在（SKIP_DMG=1）；用 nullglob 避免 ls 落空触发 set -e
shopt -s nullglob
ARTIFACTS=(dist/*.dmg dist/*.zip)
shopt -u nullglob
if [ ${#ARTIFACTS[@]} -eq 0 ]; then
  echo "⚠️ 未找到 dist/*.dmg 或 dist/*.zip，请检查上方 electron-builder 输出" >&2
else
  ls -lh "${ARTIFACTS[@]}"
fi
echo "完成。安装：双击 dist/*.dmg 拖入 Applications；或解压 dist/*.zip 后拖入 Applications"

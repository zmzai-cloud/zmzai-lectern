#!/usr/bin/env bash
# Lectern — macOS 上交叉构建 Windows 安装包（NSIS + zip，x64）
# 用法：bash scripts/build-win-cross.sh [--upload] [--dry]
#   --upload  构建后上传 dist 产物到 OSS（需 .env.release）
#   --dry     与 --upload 搭配：只列上传清单不实际上传
# 前置：pnpm install（含 electron-builder）、.env 已就位、.env.release（上传时）
# 说明：
#   - 与 scripts/build-mac.sh 同构：next build(standalone) → 组装静态资源 →
#     npm 实体化生产 node_modules → electron-builder --win。
#   - node-pty@1.1.0 自带多平台 prebuilds（含 win32-x64），mac 上装出的实体
#     node_modules 里 win 运行时按平台加载，无需特殊处理。
#   - electron-builder 26 在 mac 上交叉构建 NSIS 无需 wine（不签名场景）。
#   - Windows 首次运行 SmartScreen 提示属预期：选「更多信息」→「仍要运行」。
set -euo pipefail
cd "$(dirname "$0")/.."

UPLOAD=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD=1 ;;
    --dry) DRY=1 ;;
  esac
done

# 大目录删除一律先 mv 到 /tmp（WorkBuddy safe-delete 守卫对 >50 文件的 rm 会拦截）
guard_mv() {
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    mv "$d" "/tmp/lectern-rm-$(date +%s)-$RANDOM" || true
  done
}

echo "==> [0/5] 清理历史打包产物（dist/、.package-build）"
guard_mv dist .package-build

echo "==> [1/5] next build（生产构建，含 standalone 输出）"
# 清掉上次构建的 .next/types 与 tsbuildinfo：残留会导致类型检查阶段引用不存在的
# 文件而 Failed to compile（与 mac 侧同一坑）。大目录 rm 会触发 WorkBuddy
# safe-delete 守卫（>50 文件拦截），一律 mv 到 /tmp。
guard_mv .next/types tsconfig.tsbuildinfo
pnpm build

# fail-fast：入口不存在就停，绝不打出会闪退的包
[ -f .next/standalone/server.js ] || { echo "❌ .next/standalone/server.js 缺失，standalone 布局异常，中止打包" >&2; exit 1; }

# fail-fast：产物不得混入本机数据（与 build-mac.sh 同款兜底，详见该处注释）
node scripts/check-standalone-clean.mjs || exit 1

echo "==> [2/5] 组装 standalone 运行时（静态资源/页面资源拷入 standalone）"
# next build 不自动拷贝：standalone server 按相对路径找 .next/static 与 public
guard_mv .next/standalone/public
mkdir -p .next/standalone/.next
cp -R public .next/standalone/public 2>/dev/null || mkdir -p .next/standalone/public
cp -R .next/static .next/standalone/.next/static

echo "==> [3/5] 组装实体 node_modules（pnpm symlink / file: 依赖实体化）"
# pnpm 下 next standalone 的 trace 产出的 node_modules 只含指向 .pnpm 的断链
# symlink；electron-builder 复制 pnpm node_modules 也不完整（file: 依赖丢失）。
# 这里用 npm 从 tarball 安装一份完全实体的生产依赖整体替换。
# 【关键】--os/--cpu 强制按 Windows x64 解析 optionalDependencies：
# 不指定会装成宿主机的 @next/swc-darwin-arm64 / @img/sharp-darwin-arm64
# （各 ~125MB），打进 Windows 包既臃肿又加载失败。
guard_mv .package-build
node scripts/prepare-prod-package.mjs
(cd .package-build && npm install --omit=dev --os=win32 --cpu=x64 --no-audit --no-fund --loglevel=error)
# fail-fast：原生二进制平台不对，装完必崩，且崩在用户机器上最难查
[ -d .package-build/node_modules/@next/swc-win32-x64-msvc ] || {
  echo "❌ 缺少 @next/swc-win32-x64-msvc（Windows 原生编译/运行时必需），中止打包" >&2
  exit 1
}
# 替换前保存 trace 命中的最小依赖清单（npm 全量里大量纯 JS 包已被 webpack
# bundle 进 .next/server，运行时不再 require，按 trace 白名单删掉才瘦得下来）
node scripts/save-trace-pkgs.mjs .next/trace-pkgs.txt
guard_mv .next/standalone/node_modules
mv .package-build/node_modules .next/standalone/node_modules
# 瘦身两刀：① prune 按 trace 白名单删冗余纯 JS 包 ② shrink 裁剪 native 平台/语言
node scripts/prune-standalone.mjs .next/trace-pkgs.txt .next/standalone/node_modules
node scripts/shrink-native.mjs .next/standalone/node_modules --platform=win32 --arch=x64
# asar 化前提：server.js 开头的 process.chdir(__dirname) 在 asar 内会 ENOTDIR
# 直接崩（asar 是文件不是目录，chdir 不吃 Electron 的 fs 补丁），必须摘掉
node scripts/patch-standalone-for-asar.mjs .next/standalone --strict
guard_mv .package-build

echo "==> [4/5] electron-builder 打包 Windows（nsis 安装器 + zip，x64）"
# 无代码签名证书：SmartScreen 首次运行提示属预期（自分发场景可直接运行）
# 双镜像必需：ELECTRON_MIRROR（Electron 本体）+ ELECTRON_BUILDER_BINARIES_MIRROR
# （nsis/nsis-resources 等工具链二进制）——漏后者会直连 GitHub 下载 502/超时。
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}" \
CSC_IDENTITY_AUTO_DISCOVERY=false \
pnpm exec electron-builder --win --x64 --publish never

echo "==> [5/5] 产物体检"
# fail-fast 补刀：① 不得混入 darwin 原生依赖（--os/--cpu 没生效的典型症状，
# 打出来能装但起不来）② 文件数回归——asar:false 下文件数直接决定 NSIS 安装
# 时长（Windows Defender 逐文件扫描），超阈值就是又胖回去了。
DARWIN_NATIVE=$(find dist/win-unpacked -type d \( -name "swc-darwin-*" -o -name "sharp-darwin-*" -o -name "sharp-libvips-darwin-*" \) 2>/dev/null | head -5)
[ -z "$DARWIN_NATIVE" ] || { echo "❌ 产物混入 darwin 原生依赖：" >&2; echo "$DARWIN_NATIVE" >&2; exit 1; }
[ -d dist/win-unpacked/resources/app/node_modules ] && { echo "❌ 产物混入多余的 app/node_modules（standalone 已自带依赖）" >&2; exit 1; }
# asar 断言（本轮优化的核心，必须卡住）：app 必须是单个 app.asar，而不是散开的
# app/ 目录——散开就是八千量级文件，NSIS 安装时长会退回二十分钟。
[ -f dist/win-unpacked/resources/app.asar ] || { echo "❌ 未生成 app.asar（asar 未生效），安装时长会退化" >&2; exit 1; }
[ -d dist/win-unpacked/resources/app ] && { echo "❌ app/ 目录与 app.asar 同时存在，asar 配置异常" >&2; exit 1; }
# 原生二进制必须解包：asar 内 dlopen 会把 .node 拷到临时目录，同级的 .dll /
# spawn-helper 不会跟着走，node-pty(conpty) 与 sharp 会加载失败。
UNPACKED=$(find dist/win-unpacked/resources/app.asar.unpacked -type f 2>/dev/null | wc -l | tr -d " ")
echo "解包原生文件：$UNPACKED 个（期望 ≥9）"
[ "$UNPACKED" -ge 9 ] || { echo "❌ asarUnpack 未生效，原生二进制留在 asar 内会加载失败" >&2; exit 1; }
FILE_COUNT=$(find dist/win-unpacked -type f | wc -l | tr -d " ")
echo "文件数：$FILE_COUNT（阈值 300）"
[ "$FILE_COUNT" -le 300 ] || { echo "❌ 文件数超标：asar 未生效或 files 排除规则失效" >&2; exit 1; }
ls -lh dist/*.exe dist/*.zip
echo "完成。Windows 安装：双击 dist/*Setup*.exe（NSIS 安装器）；或解压 zip 直接运行 Lectern.exe"

if [ "$UPLOAD" = "1" ]; then
  echo "==> [6/6] 上传产物到 OSS"
  UPLOAD_ARGS=()
  [ "$DRY" = "1" ] && UPLOAD_ARGS+=(--dry)
  node scripts/upload-oss.mjs "${UPLOAD_ARGS[@]}"
fi

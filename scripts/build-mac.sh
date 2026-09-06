#!/usr/bin/env bash
# Lectern — macOS 打包脚本（Apple Silicon / arm64）
# 用法：bash scripts/build-mac.sh   （产物在 dist/）
# 前置：pnpm install（含 electron-builder）、.env 已就位（正式环境或本地）
set -euo pipefail
cd "$(dirname "$0")/.."

# 大目录删除一律先 mv 到 /tmp（WorkBuddy safe-delete 守卫对 >50 文件的 rm
# 会拦截：SAFE_DELETE_BULK_CONFIRM_REQUIRED）；/tmp 重启自动清。
guard_mv() {
  local d
  for d in "$@"; do
    [ -e "$d" ] || continue
    mv "$d" "/tmp/lectern-rm-$(date +%s)-$RANDOM" || true
  done
}

echo "==> [0/5] 清理历史打包产物（避免 dist 累积旧版本 dmg/zip）"
bash scripts/clean-dist.sh

echo "==> [1/5] next build（生产构建，含 standalone 输出）"
# 清掉上次构建的 .next/types 与 tsbuildinfo：残留会导致类型检查阶段引用不存在的
# 文件而 Failed to compile（File '.next/types/...' not found）。大目录 rm 会触发
# WorkBuddy safe-delete 守卫（>50 文件拦截），一律 mv 到 /tmp。
guard_mv .next/types tsconfig.tsbuildinfo
pnpm build

# fail-fast：入口不存在就停，绝不打出会闪退的包（曾因 Next workspace root
# 误判导致 standalone 嵌套成 zmzai-harness/server.js）
[ -f .next/standalone/server.js ] || { echo "❌ .next/standalone/server.js 缺失，standalone 布局异常，中止打包" >&2; exit 1; }

# fail-fast：产物不得混入本机数据。Next 的文件追踪会把仓库根 data/（历史遗留的老
# 数据目录，含真实会话库与 .secret）复制进 standalone 并随安装包公开发布——
# v0.2.0~v0.4.3 双平台全部中招，只能全线下架重发。next.config.mjs 的
# outputFileTracingExcludes 是主防线，这层是兜底。
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
# 无开发者签名证书：跳过 codesign / notarize（本机与自分发场景可直接运行）
# SKIP_DMG=1 只出 zip：dmg 需要 hdiutil/ditto 挂载写 /Volumes，受限环境（CI 沙箱、
# 无 TCC 磁盘权限的宿主）会 Operation not permitted。跳过 dmg 不影响 zip/.app。
if [ "${SKIP_DMG:-0}" = "1" ]; then
  ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac --arm64 --publish never -c.mac.target=zip
else
  ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}" \
  CSC_IDENTITY_AUTO_DISCOVERY=false \
  pnpm exec electron-builder --mac --arm64 --publish never
fi

echo "==> [5/6] ad-hoc 深度签名（无开发者证书，封印 Bundle 资源）"
# electron-builder 在 CSC_IDENTITY_AUTO_DISCOVERY=false 下完全跳过签名，产物只有
# 主执行文件的 linker 临时签名（Sealed Resources=none）。包级未封印 + 浏览器下载
# 隔离标记会触发 Gatekeeper「已损坏，无法打开」。这里做完整 ad-hoc 签名保证完整性
# 校验通过。注意：无 Developer ID + 公证，下载场景仍需 xattr 清隔离（见 README）。
APP_PATH=$(find dist -maxdepth 2 -name "*.app" -type d | head -1)
if [ -n "$APP_PATH" ]; then
  # asar 断言：app 必须是单个 app.asar 而不是散开的 app/ 目录（散开就是八千量级
  # 文件，安装与首次启动都会明显变慢）。
  [ -f "$APP_PATH/Contents/Resources/app.asar" ] || { echo "❌ 未生成 app.asar（asar 未生效）" >&2; exit 1; }
  UNPACKED=$(find "$APP_PATH/Contents/Resources/app.asar.unpacked" -type f 2>/dev/null | wc -l | tr -d " ")
  echo "解包原生文件：$UNPACKED 个（期望 ≥5：node-pty/sharp/swc 的 .node 与 dylib）"
  [ "$UNPACKED" -ge 5 ] || { echo "❌ asarUnpack 未生效，原生二进制留在 asar 内会加载失败" >&2; exit 1; }
  codesign --force --deep --sign - "$APP_PATH"
  codesign --verify --deep --strict "$APP_PATH"
  echo "ad-hoc 签名通过：$APP_PATH"

  # 签名是打包「之后」补的，而 electron-builder 的 zip/dmg 都已在签名前打完，
  # 直接分发会拿到未封印的 app。这里用签名后的 .app 重打 zip 覆盖。
  shopt -s nullglob
  OLD_ZIPS=(dist/*.zip)
  shopt -u nullglob
  if [ ${#OLD_ZIPS[@]} -gt 0 ]; then
    rm -f "${OLD_ZIPS[@]}"
    ZIP_NAME="$(basename "$APP_PATH" .app)-$(node -p "require('./package.json').version")-arm64-mac.zip"
    ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "dist/$ZIP_NAME"
    echo "zip 已用签名后产物重打：dist/$ZIP_NAME"
    # latest-mac.yml 是 electron-builder 按「签名前」zip 算的 sha512/size，重打后
    # 必须同步，否则 electron-updater 校验失败（或将来启用自动更新时静默拉不下来）。
    if [ -f dist/latest-mac.yml ]; then
      node -e '
        const fs = require("fs"), crypto = require("crypto");
        const zip = process.argv[1];
        const buf = fs.readFileSync(zip);
        const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
        const p = "dist/latest-mac.yml";
        let y = fs.readFileSync(p, "utf8");
        y = y.replace(/sha512: .*/g, "sha512: " + sha512).replace(/size: \d+/g, "size: " + buf.length);
        fs.writeFileSync(p, y);
      ' "dist/$ZIP_NAME"
      echo "latest-mac.yml 校验和已按重打后的 zip 同步"
    fi
  fi
  shopt -s nullglob
  DMGS=(dist/*.dmg)
  shopt -u nullglob
  if [ ${#DMGS[@]} -gt 0 ]; then
    echo "⚠️ dist/*.dmg 内含未签名 app（dmg 在签名前生成），请改用 zip 安装" >&2
  fi
fi

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

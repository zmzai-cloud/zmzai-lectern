# Lectern — Windows 打包脚本（x64）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1 [-Upload] [-Dry]
#   -Upload   构建后上传 dist 产物到 OSS（需 .env.release，见 scripts\.env.release.example）
#   -Dry      上传开关生效时只列清单不实际上传
# 前置：
#   - Node 20+ / pnpm（corepack enable）/ 已 pnpm install（含 electron-builder）
#   - .env 已就位（正式环境或本地）
#   - 建议在 Windows 机器上跑；electron-builder 的 nsis 目标在非 Windows 也可打，
#     但 standalone 由 Electron 内置 node 运行，同平台打包最稳。
# 与 scripts/build-mac.sh 同构：next build(standalone) → 组装静态资源 →
# npm 实体化生产 node_modules → electron-builder --win。
param(
  [switch]$Upload,
  [switch]$Dry
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Preserve-BuildPath($Path) {
  if (Test-Path $Path) {
    $Backup = Join-Path ([System.IO.Path]::GetTempPath()) ("lectern-build-" + [guid]::NewGuid().ToString())
    Move-Item -LiteralPath $Path -Destination $Backup
    Write-Host "Previous build preserved: $Backup"
  }
}

if ($env:LECTERN_REQUIRE_SIGNING -eq "1") {
  node scripts/signing-preflight.mjs win32
  if ($LASTEXITCODE -ne 0) { throw "Signing credentials missing" }
}

# 国内镜像（可覆盖）：Electron 二进制下载与 mac 侧同源
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/" }

Step "[0/6] 清理历史打包产物（dist/、.package-build）"
Preserve-BuildPath "dist"
Preserve-BuildPath ".package-build"

Step "[1/6] next build（生产构建，含 standalone 输出）"
# 清掉上次构建的 .next/types 与 tsbuildinfo：残留会导致类型检查阶段引用
# 不存在的文件而 Failed to compile（与 mac 侧同一坑）
Preserve-BuildPath ".next"
Preserve-BuildPath "tsconfig.tsbuildinfo"
pnpm build
if ($LASTEXITCODE -ne 0) { throw "next build 失败" }

# fail-fast：入口不存在就停，绝不打出会闪退的包（与 mac 侧同一防线）
if (-not (Test-Path .next\standalone\server.js)) {
  throw ".next\standalone\server.js 缺失，standalone 布局异常，中止打包"
}
# Windows 原生构建的已知 Next 缺陷：源码 app/** 会被追进 standalone（trace 插件
# 的 bundled 过滤在 Windows 上失效）。逐文件镜像校验后清理；校验不过即中止。
node scripts/strip-standalone-source.mjs
if ($LASTEXITCODE -ne 0) { throw "standalone source residue failed mirror verification" }
node scripts/check-standalone-clean.mjs
if ($LASTEXITCODE -ne 0) { throw "Private data detected in standalone output" }

Step "[2/6] 组装 standalone 运行时（静态资源/页面资源拷入 standalone）"
# next build 不自动拷贝：standalone server 按相对路径找 .next/static 与 public
if (Test-Path .next\standalone\public) { Remove-Item -Recurse -Force .next\standalone\public }
New-Item -ItemType Directory -Force -Path .next\standalone\.next | Out-Null
if (Test-Path public) { Copy-Item -Recurse -Force public .next\standalone\public }
Copy-Item -Recurse -Force .next\static .next\standalone\.next\static

Step "[3/6] 组装实体 node_modules（pnpm symlink / file: 依赖实体化）"
# pnpm 下 next standalone 的 trace 产出的 node_modules 只含指向 .pnpm 的断链
# symlink；electron-builder 复制 pnpm node_modules 也不完整（file: 依赖丢失）。
# prepare-prod-package.mjs 把 file:/link: 私有包替换为 npm pack 的 tarball，
# 再用 npm 装出完全实体的生产依赖整体替换（脚本为 node 实现，跨平台复用）。
Remove-Item -Recurse -Force .package-build -ErrorAction SilentlyContinue
node scripts/prepare-prod-package.mjs
if ($LASTEXITCODE -ne 0) { throw "prepare-prod-package 失败" }
Push-Location .package-build
npm install --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm install（生产依赖实体化）失败" }
Pop-Location
if (-not (Test-Path .package-build\node_modules\@next\swc-win32-x64-msvc)) {
  throw "Missing Windows x64 SWC runtime"
}
node scripts/save-trace-pkgs.mjs .next/trace-pkgs.txt
if ($LASTEXITCODE -ne 0) { throw "Dependency trace collection failed" }
if (Test-Path .next\standalone\node_modules) { Remove-Item -Recurse -Force .next\standalone\node_modules }
Move-Item .package-build\node_modules .next\standalone\node_modules
node scripts/prune-standalone.mjs .next/trace-pkgs.txt .next/standalone/node_modules
if ($LASTEXITCODE -ne 0) { throw "Dependency pruning failed" }
node scripts/shrink-native.mjs .next/standalone/node_modules --platform=win32 --arch=x64
if ($LASTEXITCODE -ne 0) { throw "Native dependency pruning failed" }
node scripts/patch-standalone-for-asar.mjs .next/standalone --strict
if ($LASTEXITCODE -ne 0) { throw "Standalone asar patch failed" }
Remove-Item -Recurse -Force .package-build -ErrorAction SilentlyContinue

Step "[4/6] 打包前自检（Windows 关键项）"
# 用户配置不得混入包；公开服务默认值由 Electron 主进程注入。
node scripts/check-standalone-clean.mjs
if ($LASTEXITCODE -ne 0) { throw "Package safety check failed" }

Step "[5/6] electron-builder 打包 Windows（nsis 安装器 + zip，x64）"
# 无代码签名证书：自分发场景可直接运行（SmartScreen 首次运行会提示，属预期）
$BuilderArgs = @("--win", "--x64", "--publish", "never")
if ($env:LECTERN_REQUIRE_SIGNING -eq "1") { $BuilderArgs += "-c.forceCodeSigning=true" }
pnpm exec electron-builder @BuilderArgs
if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }

Step "[6/6] 产物"
node scripts/release-validation.mjs package dist/win-unpacked/resources/app.asar win32
if ($LASTEXITCODE -ne 0) { throw "Packaged app verification failed" }
node scripts/release-validation.mjs release dist win32
if ($LASTEXITCODE -ne 0) { throw "Release manifest verification failed" }
if ($env:LECTERN_REQUIRE_SIGNING -eq "1") {
  $SignedFiles = @("dist\win-unpacked\Lectern.exe") + @(Get-ChildItem "dist\Lectern-Setup-*.exe" | ForEach-Object { $_.FullName })
  foreach ($SignedFile in $SignedFiles) {
    if ((Get-AuthenticodeSignature $SignedFile).Status -ne "Valid") { throw "Invalid Authenticode signature: $SignedFile" }
  }
}
Get-ChildItem dist\*.exe, dist\*.zip -ErrorAction SilentlyContinue | Format-Table Name, @{L="Size"; E={"{0:N1} MB" -f ($_.Length / 1MB)}}
Write-Host "完成。安装：双击 dist\*Setup*.exe（NSIS 安装器，可选安装目录）；或解压 zip 直接运行 Lectern.exe"
Write-Host "注意：Windows 首次运行 SmartScreen 可能提示未签名应用 → 「更多信息」→「仍要运行」。"

if ($Upload) {
  Step "[7/6] 上传产物到 OSS"
  $uploadArgs = @()
  if ($Dry) { $uploadArgs += "--dry" }
  node scripts/upload-oss.mjs @uploadArgs
  if ($LASTEXITCODE -ne 0) { throw "OSS 上传失败" }
}

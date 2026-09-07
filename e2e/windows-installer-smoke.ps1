$ErrorActionPreference = "Stop"
if ($env:CI -ne "true" -or -not $env:RUNNER_TEMP) {
  throw "Installer smoke may only run in an isolated CI runner"
}
Set-Location (Split-Path -Parent $PSScriptRoot)
$Version = (Get-Content package.json | ConvertFrom-Json).version
$Installer = (Resolve-Path "dist\Lectern-Setup-$Version.exe").Path
$InstallDir = Join-Path $env:RUNNER_TEMP ("Lectern Install " + [guid]::NewGuid().ToString())
$Process = Start-Process -FilePath $Installer -ArgumentList @("/S", "/D=$InstallDir") -Wait -PassThru
if ($Process.ExitCode -ne 0) { throw "Installer failed: $($Process.ExitCode)" }
$App = Join-Path $InstallDir "Lectern.exe"
if (-not (Test-Path $App)) { throw "Installer did not produce Lectern.exe" }
node e2e/packaged-smoke.mjs "$App"
if ($LASTEXITCODE -ne 0) { throw "Installed application smoke failed" }
$Uninstaller = Get-ChildItem -LiteralPath $InstallDir -Filter "Uninstall*.exe" | Select-Object -First 1
if (-not $Uninstaller) { throw "Uninstaller missing" }
$Process = Start-Process -FilePath $Uninstaller.FullName -ArgumentList @("/S", "_?=$InstallDir") -Wait -PassThru
if ($Process.ExitCode -ne 0) { throw "Uninstaller failed: $($Process.ExitCode)" }
if (Test-Path $App) { throw "Uninstall left application executable behind" }
Write-Host "Windows install, packaged workflows and uninstall passed"

$ErrorActionPreference = "Stop"
if ($env:CI -ne "true" -or -not $env:RUNNER_TEMP) {
  throw "Cross-drive smoke may only run in an isolated CI runner"
}
Set-Location (Split-Path -Parent $PSScriptRoot)
$Fixture = Join-Path $env:RUNNER_TEMP ("lectern-cross-drive-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Fixture | Out-Null
# Use an unused drive letter, never an existing volume or user mapping.
$Drive = @("Z:", "Y:", "X:", "W:") | Where-Object { -not (Test-Path "$_\") } | Select-Object -First 1
if (-not $Drive) { throw "No free drive letter for the cross-drive fixture" }
$PreviousReport = $env:LECTERN_SMOKE_REPORT_DIR
$PreviousCrossDrive = $env:LECTERN_SMOKE_CROSS_DRIVE
$Mapped = $false
try {
  subst.exe $Drive $Fixture
  if ($LASTEXITCODE -ne 0) { throw "Unable to create fixture drive" }
  $Mapped = $true
  # Chinese characters plus spaces, without relying on PowerShell file encoding.
  $FolderName = "Lectern " + [char]0x5de5 + [char]0x5177 + " with spaces"
  $InstallDir = Join-Path "$Drive\" $FolderName
  Copy-Item -LiteralPath "dist\win-unpacked" -Destination $InstallDir -Recurse
  $App = Join-Path $InstallDir "Lectern.exe"
  $ProfileDrive = [IO.Path]::GetPathRoot([IO.Path]::GetTempPath())
  if ([IO.Path]::GetPathRoot($App) -eq $ProfileDrive) { throw "Fixture does not cross drives" }
  $env:LECTERN_SMOKE_REPORT_DIR = "test-results/packaged-cross-drive"
  $env:LECTERN_SMOKE_CROSS_DRIVE = "1"
  node e2e/packaged-smoke.mjs "$App"
  if ($LASTEXITCODE -ne 0) { throw "Cross-drive packaged application smoke failed" }
} finally {
  $env:LECTERN_SMOKE_REPORT_DIR = $PreviousReport
  $env:LECTERN_SMOKE_CROSS_DRIVE = $PreviousCrossDrive
  if ($Mapped) { subst.exe $Drive /D }
}
Write-Host "Windows cross-drive homepage, APIs, terminal and restart passed"

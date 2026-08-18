<#
.SYNOPSIS
  Builds the Windows installer for Hunting Map Generator (x86_64).

.DESCRIPTION
  Must run on Windows. Tauri links against WebView2 via the MSVC toolchain, so
  there is no supported way to cross-compile this from macOS or Linux — build
  on a Windows machine, a Windows VM, or CI (see BUILDING.md).

  Produces an NSIS installer (.exe) under
  src-tauri\target\release\bundle\nsis\. It installs per-user by default (see
  bundle.windows.nsis.installMode in tauri.conf.json) — no Administrator
  prompt, matching the account-free, no-telemetry spirit of the app.

.PARAMETER Deps
  Install build prerequisites first (winget: Rust MSVC toolchain, VS Build
  Tools, Node.js) before building.

.EXAMPLE
  .\scripts\build-windows.ps1 -Deps
  .\scripts\build-windows.ps1
#>
param(
  [switch]$Deps
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# $IsWindows only exists in PowerShell 7+ (pwsh) — undefined in the Windows
# PowerShell 5.1 that ships by default on many machines, where it would
# silently evaluate as falsy and make this guard reject every platform,
# including Windows itself. $env:OS is a real environment variable present
# under both cmd.exe and every PowerShell version on Windows.
if ($env:OS -ne "Windows_NT") {
  Write-Error @"
This script must run on Windows.

Tauri builds against WebView2 via the MSVC linker, so a Windows installer
cannot be produced from macOS or Linux. Use one of:
  - a Windows 10/11 machine or VM
  - CI (see BUILDING.md)
"@
  exit 1
}

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  Write-Warning "Building on $($env:PROCESSOR_ARCHITECTURE); the published target is x86_64 (AMD64)."
}

if ($Deps) {
  Write-Host "==> Installing build prerequisites" -ForegroundColor Cyan
  # Rust's MSVC toolchain (not GNU) is what Tauri expects on Windows; the VS
  # Build Tools workload below supplies the linker/headers it needs. WebView2
  # itself ships with Windows 10 21H2+/Windows 11 — no separate install here,
  # and the NSIS installer can bootstrap it for end users on older systems
  # (bundle.windows.nsis in tauri.conf.json).
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
    --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" `
    --accept-source-agreements --accept-package-agreements
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements

  Write-Host "==> Restart this shell so PATH updates take effect, then re-run without -Deps." -ForegroundColor Yellow
  exit 0
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Error "cargo not found — install Rust from https://rustup.rs, or re-run with -Deps"
  exit 1
}

$rustHost = ((rustc -vV | Select-String "^host:").ToString()) -replace "^host:\s*", ""
if ($rustHost -notmatch "msvc") {
  Write-Warning "Active Rust toolchain is '$rustHost', not an MSVC target. Tauri on Windows expects MSVC:"
  Write-Warning "  rustup default stable-x86_64-pc-windows-msvc"
}

Write-Host "==> Building frontend + Tauri bundle" -ForegroundColor Cyan
# `tauri build` runs the frontend build itself via beforeBuildCommand.
if (Get-Command yarn -ErrorAction SilentlyContinue) {
  yarn tauri build --bundles nsis
} else {
  npx tauri build --bundles nsis
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bundleDir = "src-tauri\target\release\bundle\nsis"
Write-Host ""
Write-Host "==> Built:" -ForegroundColor Cyan
Get-ChildItem $bundleDir -Filter "*.exe" | ForEach-Object {
  "{0,10:N0} KB  {1}" -f ($_.Length / 1KB), $_.Name
}

#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot dev environment setup for LectorBit (Windows / PowerShell).
.DESCRIPTION
    - Ensures ~/.cargo/bin is on PATH for this session.
    - Installs the pinned rust toolchain (1.97.1) and sets it as default.
    - Installs tauri-cli 2.11 (locked).
    - Installs frontend deps via pnpm.
    - Launches `cargo tauri dev` for the desktop shell.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# 1. PATH fix for current session
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:Path = "$env:LOCALAPPDATA\pnpm;$env:Path"   # pnpm fallback

Write-Step "Verifying prerequisites"
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$rustup = Get-Command rustup -ErrorAction SilentlyContinue
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue

if (-not $cargo) {
    Write-Error "cargo still not found at $env:USERPROFILE\.cargo\bin\cargo.exe. Open a NEW PowerShell window and re-run this script."
}
if (-not $pnpm) {
    Write-Warning "pnpm not found. Install with: npm install -g pnpm   (then re-run this script)"
}
Write-Host "cargo : $($cargo.Version)" -ForegroundColor Green
Write-Host "pnpm  : $($pnpm.Version)" -ForegroundColor Green

# 2. Pinned toolchain
Write-Step "Installing rust toolchain 1.97.1"
& rustup toolchain install 1.97.1
& rustup default 1.97.1
& rustc --version

# 3. Tauri CLI
Write-Step "Installing tauri-cli (2.11, locked)"
& cargo install tauri-cli --version "^2.11" --locked

# 4. Frontend deps
Write-Step "Installing frontend dependencies"
Push-Location lectorbit_frontend
if (Test-Path pnpm-lock.yaml) {
    & pnpm install --frozen-lockfile
} else {
    & pnpm install
}
Pop-Location

# 5. Launch
Write-Step "Launching cargo tauri dev"
Push-Location lectorbit_backend
& cargo tauri dev

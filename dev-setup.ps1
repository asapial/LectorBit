#Requires -Version 5.1
<#
.SYNOPSIS
    One-shot dev environment setup for LectorBit (Windows / PowerShell).
.DESCRIPTION
    - Ensures ~/.cargo/bin is on PATH for this session.
    - Installs the pinned rust toolchain (1.97.1) and sets it as default.
    - Installs tauri-cli 2.11 (locked).
    - Installs the pinned FFmpeg/ffprobe media inspector.
    - Installs the pinned whisper.cpp local transcription engine.
    - Installs frontend deps via pnpm.
    - Launches `cargo tauri dev` for the desktop shell.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$pinnedFfmpegVersion = '8.1.2'

function Resolve-PinnedMediaTool {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Candidate,

        [Parameter(Mandatory = $true)]
        [ValidateSet('ffmpeg', 'ffprobe')]
        [string]$ToolName
    )

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $null
    }

    $process = $null
    try {
        $resolvedCandidate = (Resolve-Path -LiteralPath $Candidate -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolvedCandidate -PathType Leaf)) {
            return $null
        }

        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $resolvedCandidate
        $startInfo.Arguments = '-version'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $versionOutput = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            return $null
        }

        $versionPattern = "(?m)^$([regex]::Escape($ToolName)) version $([regex]::Escape($pinnedFfmpegVersion))(?:\s|-)"
        if ($versionOutput -notmatch $versionPattern) {
            return $null
        }

        return [System.IO.Path]::GetFullPath($resolvedCandidate)
    } catch {
        return $null
    } finally {
        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

function Resolve-PinnedMediaToolOnPath {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('ffmpeg', 'ffprobe')]
        [string]$ToolName
    )

    $command = Get-Command $ToolName -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $command) {
        return $null
    }
    Resolve-PinnedMediaTool -Candidate $command.Source -ToolName $ToolName
}

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

# 2. Pinned media inspector
Write-Step "Verifying FFmpeg $pinnedFfmpegVersion"
$ffprobePath = Resolve-PinnedMediaTool -Candidate $env:LECTORBIT_FFPROBE_PATH -ToolName 'ffprobe'
if ($env:LECTORBIT_FFPROBE_PATH -and -not $ffprobePath) {
    Write-Warning "LECTORBIT_FFPROBE_PATH does not point to ffprobe $pinnedFfmpegVersion; checking other pinned locations."
}

$ffmpegPath = Resolve-PinnedMediaTool -Candidate $env:LECTORBIT_FFMPEG_PATH -ToolName 'ffmpeg'
if ($env:LECTORBIT_FFMPEG_PATH -and -not $ffmpegPath) {
    Write-Warning "LECTORBIT_FFMPEG_PATH does not point to ffmpeg $pinnedFfmpegVersion; checking other pinned locations."
}

if (-not $ffmpegPath -and $ffprobePath) {
    $ffmpegPath = Resolve-PinnedMediaTool -Candidate (
        Join-Path (Split-Path -Parent $ffprobePath) 'ffmpeg.exe'
    ) -ToolName 'ffmpeg'
}
if (-not $ffprobePath -and $ffmpegPath) {
    $ffprobePath = Resolve-PinnedMediaTool -Candidate (
        Join-Path (Split-Path -Parent $ffmpegPath) 'ffprobe.exe'
    ) -ToolName 'ffprobe'
}
if (-not $ffprobePath) {
    $ffprobePath = Resolve-PinnedMediaToolOnPath -ToolName 'ffprobe'
}
if (-not $ffmpegPath) {
    $ffmpegPath = Resolve-PinnedMediaToolOnPath -ToolName 'ffmpeg'
}

if (-not $ffprobePath -or -not $ffmpegPath) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Error "ffmpeg and ffprobe $pinnedFfmpegVersion are required. Install Gyan.FFmpeg $pinnedFfmpegVersion or set both LECTORBIT_FFMPEG_PATH and LECTORBIT_FFPROBE_PATH to verified absolute paths."
    }
    & winget install --id Gyan.FFmpeg --version $pinnedFfmpegVersion --source winget --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not install the pinned FFmpeg package."
    }
}

$wingetBinDirectory = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-$pinnedFfmpegVersion-full_build\bin"
if (-not $ffprobePath) {
    $ffprobePath = Resolve-PinnedMediaTool -Candidate (
        Join-Path $wingetBinDirectory 'ffprobe.exe'
    ) -ToolName 'ffprobe'
}
if (-not $ffmpegPath) {
    $ffmpegPath = Resolve-PinnedMediaTool -Candidate (
        Join-Path $wingetBinDirectory 'ffmpeg.exe'
    ) -ToolName 'ffmpeg'
}
if (-not $ffprobePath -or -not $ffmpegPath) {
    Write-Error "FFmpeg setup completed without verified ffmpeg and ffprobe $pinnedFfmpegVersion executables."
}

$env:LECTORBIT_FFPROBE_PATH = $ffprobePath
$env:LECTORBIT_FFMPEG_PATH = $ffmpegPath
Write-Host "ffprobe: $ffprobePath" -ForegroundColor Green
Write-Host "ffmpeg : $ffmpegPath" -ForegroundColor Green

# 3. Pinned local transcription engine
Write-Step "Verifying whisper.cpp 1.9.2"
& (Join-Path $PSScriptRoot 'scripts\setup-whisper.ps1')
if (-not $env:LECTORBIT_WHISPER_PATH -or -not (Test-Path -LiteralPath $env:LECTORBIT_WHISPER_PATH -PathType Leaf)) {
    Write-Error "whisper.cpp setup did not provide a usable LECTORBIT_WHISPER_PATH."
}

# 4. Pinned toolchain
Write-Step "Installing rust toolchain 1.97.1"
& rustup toolchain install 1.97.1
& rustup default 1.97.1
& rustc --version

# 5. Tauri CLI
Write-Step "Installing tauri-cli (2.11, locked)"
& cargo install tauri-cli --version "^2.11" --locked

# 6. Frontend deps
Write-Step "Installing frontend dependencies"
Push-Location lectorbit_frontend
if (Test-Path pnpm-lock.yaml) {
    & pnpm install --frozen-lockfile
} else {
    & pnpm install
}
Pop-Location

# 7. Launch
Write-Step "Launching cargo tauri dev"
Push-Location lectorbit_backend
& cargo tauri dev

#Requires -Version 5.1
<#
.SYNOPSIS
    Builds a complete unsigned LectorBit installer for Windows 10/11 x64.
.DESCRIPTION
    Verifies and stages the pinned local FFmpeg 8.1.2 evaluation binaries and
    manifest-backed whisper.cpp runtime, writes a byte-level receipt, bundles an
    selected WebView2 installer mode, and creates a current-user NSIS setup
    executable.

    This pathway is intended for local evaluation builds. Public distribution
    remains fail-closed until the canonical sidecar manifests and Authenticode
    signing are complete.
#>

[CmdletBinding()]
param(
    [string]$FfmpegPath,
    [string]$FfprobePath,
    [ValidateSet('offlineInstaller', 'downloadBootstrapper')]
    [string]$WebViewInstallMode = 'offlineInstaller',
    [ValidateSet('zlib', 'lzma')]
    [string]$Compression = 'zlib',
    [switch]$DebugBuild,
    [switch]$StageOnly,
    [switch]$BundleOnly
)

$ErrorActionPreference = 'Stop'
$expectedFfmpegVersion = '8.1.2'
$targetTriple = 'x86_64-pc-windows-msvc'
$expectedLocalBinarySha256 = @{
    'ffmpeg.exe'  = 'ad8f211bc894755e0061c55ab280ae00e8d3d4f15a8cc4372b24cfa247b5942e'
    'ffprobe.exe' = '9df3b0b5275e830961df6d94e1f7a71121a7abd5ff708e9fec8a0b6084a55015'
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'LectorBit Windows packaging requires a 64-bit Windows host.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$backendRoot = Join-Path $repositoryRoot 'lectorbit_backend'
$tauriRoot = Join-Path $backendRoot 'src-tauri'
$targetRoot = [IO.Path]::GetFullPath((Join-Path $backendRoot 'target'))
$workRoot = [IO.Path]::GetFullPath((Join-Path $targetRoot 'lectorbit-windows-local'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $workRoot 'sidecars'))
$buildTarget = [IO.Path]::GetFullPath((Join-Path $targetRoot 'windows-local-build'))
$overlayPath = Join-Path $workRoot 'tauri.windows-local.conf.json'
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'artifacts\windows-local'))
$whisperSource = Join-Path $tauriRoot 'resources\sidecars'
$whisperManifestPath = Join-Path $backendRoot 'sidecars\manifests\whisper-cli-1.9.2.json'
$buildProfile = if ($DebugBuild) { 'debug' } else { 'release' }

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-OwnedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnedRoot
    )
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    $resolvedRoot = [IO.Path]::GetFullPath($OwnedRoot).TrimEnd([char[]]@('\', '/'))
    $prefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside $resolvedRoot`: $resolvedPath"
    }
}

function Reset-OwnedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$OwnedRoot
    )
    Assert-OwnedPath -Path $Path -OwnedRoot $OwnedRoot
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Resolve-Executable {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$RequestedPath
    )
    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $command = Get-Command $Name -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $candidate = $command.Source
    }
    if (-not [IO.Path]::IsPathRooted($candidate)) {
        throw "$Name must resolve to an absolute path."
    }
    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$Name must be a regular file, not a directory or reparse point."
    }
    $resolved
}

function Get-VersionOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component
    )
    $lines = @(& $Path -version 2>&1)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) {
        throw "$Component could not report its version."
    }
    $firstLine = [string]$lines[0]
    if ($firstLine -notmatch "^$([regex]::Escape($Component)) version $([regex]::Escape($expectedFfmpegVersion))(?:[-\s]|$)") {
        throw "$Component $expectedFfmpegVersion is required; received: $firstLine"
    }
    ($lines | Out-String).Trim()
}

function Copy-VerifiedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Nullable[long]]$ExpectedSize
    )
    $sourceItem = Get-Item -LiteralPath $Source -Force
    if ($sourceItem.PSIsContainer -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to stage non-regular file $Source"
    }
    if ($ExpectedSize -ne $null -and $sourceItem.Length -ne [long]$ExpectedSize) {
        throw "Unexpected size for $($sourceItem.Name): $($sourceItem.Length)"
    }
    $sourceHash = Get-Sha256 -Path $Source
    if ($sourceHash -ne $ExpectedSha256) {
        throw "SHA-256 verification failed for $($sourceItem.Name)."
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $destinationHash = Get-Sha256 -Path $Destination
    if ($destinationHash -ne $sourceHash) {
        throw "Post-copy verification failed for $($sourceItem.Name)."
    }
}

$resolvedFfmpeg = Resolve-Executable -Name 'ffmpeg.exe' -RequestedPath $FfmpegPath
$resolvedFfprobe = Resolve-Executable -Name 'ffprobe.exe' -RequestedPath $FfprobePath
$ffmpegVersionOutput = Get-VersionOutput -Path $resolvedFfmpeg -Component 'ffmpeg'
$ffprobeVersionOutput = Get-VersionOutput -Path $resolvedFfprobe -Component 'ffprobe'

foreach ($binary in @($resolvedFfmpeg, $resolvedFfprobe)) {
    $filename = [IO.Path]::GetFileName($binary).ToLowerInvariant()
    $actualHash = Get-Sha256 -Path $binary
    if ($actualHash -ne $expectedLocalBinarySha256[$filename]) {
        throw "$filename is version-correct but is not the pinned LectorBit evaluation artifact."
    }
}

$ffmpegRoot = Split-Path -Parent (Split-Path -Parent $resolvedFfmpeg)
$ffprobeRoot = Split-Path -Parent (Split-Path -Parent $resolvedFfprobe)
if (-not $ffmpegRoot.Equals($ffprobeRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ffmpeg.exe and ffprobe.exe must come from the same verified distribution.'
}
$ffmpegLicense = Join-Path $ffmpegRoot 'LICENSE'
$ffmpegReadme = Join-Path $ffmpegRoot 'README.txt'
foreach ($legalFile in @($ffmpegLicense, $ffmpegReadme)) {
    if (-not (Test-Path -LiteralPath $legalFile -PathType Leaf)) {
        throw "The FFmpeg distribution is missing required legal file $legalFile"
    }
}

if (-not (Test-Path -LiteralPath $whisperManifestPath -PathType Leaf)) {
    throw 'The checked-in whisper.cpp provenance manifest is missing.'
}
if (-not (Test-Path -LiteralPath $whisperSource -PathType Container)) {
    Write-Host 'Installing the pinned whisper.cpp runtime first...' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'setup-whisper.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'whisper.cpp setup failed.' }
}

$whisperManifest = Get-Content -LiteralPath $whisperManifestPath -Raw | ConvertFrom-Json
$whisperArtifacts = @($whisperManifest.artifacts | Where-Object target_triple -eq $targetTriple)
if ($whisperArtifacts.Count -eq 0) {
    throw "The whisper.cpp manifest has no artifacts for $targetTriple."
}

Reset-OwnedDirectory -Path $stagingRoot -OwnedRoot $targetRoot
Copy-VerifiedFile -Source $resolvedFfmpeg -Destination (Join-Path $stagingRoot 'ffmpeg.exe') -ExpectedSha256 $expectedLocalBinarySha256['ffmpeg.exe'] -ExpectedSize $null
Copy-VerifiedFile -Source $resolvedFfprobe -Destination (Join-Path $stagingRoot 'ffprobe.exe') -ExpectedSha256 $expectedLocalBinarySha256['ffprobe.exe'] -ExpectedSize $null
Copy-VerifiedFile -Source $ffmpegLicense -Destination (Join-Path $stagingRoot 'FFmpeg-LICENSE.txt') -ExpectedSha256 (Get-Sha256 -Path $ffmpegLicense) -ExpectedSize (Get-Item -LiteralPath $ffmpegLicense).Length
Copy-VerifiedFile -Source $ffmpegReadme -Destination (Join-Path $stagingRoot 'FFmpeg-README.txt') -ExpectedSha256 (Get-Sha256 -Path $ffmpegReadme) -ExpectedSize (Get-Item -LiteralPath $ffmpegReadme).Length

foreach ($artifact in $whisperArtifacts) {
    $source = Join-Path $whisperSource ([string]$artifact.filename)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Run scripts/setup-whisper.ps1; missing $($artifact.filename)."
    }
    Copy-VerifiedFile -Source $source -Destination (Join-Path $stagingRoot ([string]$artifact.filename)) -ExpectedSha256 ([string]$artifact.sha256) -ExpectedSize ([long]$artifact.size_bytes)
}

$receiptFiles = @(
    Get-ChildItem -LiteralPath $stagingRoot -File |
        Sort-Object Name |
        ForEach-Object {
            [ordered]@{
                filename = $_.Name
                size_bytes = $_.Length
                sha256 = Get-Sha256 -Path $_.FullName
            }
        }
)
$receipt = [ordered]@{
    schema_version = 1
    build_kind = 'unsigned-local-evaluation'
    cargo_profile = $buildProfile
    target_triple = $targetTriple
    webview_install_mode = $WebViewInstallMode
    installer_compression = $Compression
    generated_at = [DateTimeOffset]::UtcNow.ToString('o')
    components = [ordered]@{
        ffmpeg = [ordered]@{
            version = $expectedFfmpegVersion
            source_package = 'Gyan.FFmpeg (local WinGet installation)'
            version_output = $ffmpegVersionOutput
        }
        ffprobe = [ordered]@{
            version = $expectedFfmpegVersion
            source_package = 'Gyan.FFmpeg (local WinGet installation)'
            version_output = $ffprobeVersionOutput
        }
        whisper = [ordered]@{
            version = [string]$whisperManifest.version
            source = [string]$whisperManifest.source
            manifest = 'lectorbit_backend/sidecars/manifests/whisper-cli-1.9.2.json'
        }
    }
    files = $receiptFiles
}
$receiptPath = Join-Path $stagingRoot 'sidecar-receipt.json'
[IO.File]::WriteAllText(
    $receiptPath,
    (($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$resourceKey = $stagingRoot.Replace('\', '/') + '/'
$overlay = [ordered]@{
    bundle = [ordered]@{
        targets = @('nsis')
        createUpdaterArtifacts = $false
        resources = [ordered]@{ $resourceKey = 'sidecars/' }
        windows = [ordered]@{
            allowDowngrades = $false
            webviewInstallMode = [ordered]@{ type = $WebViewInstallMode; silent = $true }
            nsis = [ordered]@{
                installMode = 'currentUser'
                installerIcon = 'icons/icon.ico'
                compression = $Compression
                startMenuFolder = 'LectorBit'
                installerHooks = 'windows/installer-hooks.nsh'
            }
        }
    }
}
[IO.File]::WriteAllText(
    $overlayPath,
    (($overlay | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
)

Write-Host "Verified and staged $($receiptFiles.Count) runtime files." -ForegroundColor Green
if ($StageOnly) {
    Write-Host "Stage-only validation complete: $stagingRoot" -ForegroundColor Green
    return
}

foreach ($commandName in @('cargo', 'pnpm')) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "$commandName is required to build the Windows installer."
    }
}

Write-Host ''
Write-Host "Building the Windows 10/11 x64 installer ($buildProfile, $WebViewInstallMode, $Compression)..." -ForegroundColor Cyan
$previousCargoTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = $buildTarget
try {
    Push-Location $backendRoot
    try {
        if ($BundleOnly) {
            $existingBinary = Join-Path $buildTarget "$buildProfile\lectorbit.exe"
            if (-not (Test-Path -LiteralPath $existingBinary -PathType Leaf)) {
                throw "BundleOnly requires an existing $buildProfile binary from this packaging script."
            }
            $tauriArguments = @('tauri', 'bundle')
            if ($DebugBuild) { $tauriArguments += '--debug' }
            $tauriArguments += @('--ci', '--bundles', 'nsis', '--no-sign', '--config', $overlayPath)
            & cargo @tauriArguments
        } else {
            $tauriArguments = @('tauri', 'build')
            if ($DebugBuild) { $tauriArguments += '--debug' }
            $tauriArguments += @('--ci', '--bundles', 'nsis', '--no-sign', '--config', $overlayPath, '--', '--locked')
            & cargo @tauriArguments
        }
        if ($LASTEXITCODE -ne 0) { throw "Tauri installer build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} finally {
    $env:CARGO_TARGET_DIR = $previousCargoTarget
}

$bundleDirectory = Join-Path $buildTarget "$buildProfile\bundle\nsis"
$builtInstaller = Get-ChildItem -LiteralPath $bundleDirectory -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $builtInstaller) { throw "No NSIS installer was produced in $bundleDirectory" }

$baseConfig = Get-Content -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$profileLabel = if ($DebugBuild) { '-DEBUG' } else { '' }
$artifactName = "LectorBit_$($baseConfig.version)_x64$profileLabel-UNSIGNED-setup.exe"
$artifactPath = Join-Path $artifactRoot $artifactName
Copy-Item -LiteralPath $builtInstaller.FullName -Destination $artifactPath -Force
Copy-Item -LiteralPath $receiptPath -Destination (Join-Path $artifactRoot 'sidecar-receipt.json') -Force

# A release artifact is the handoff build. Remove the older debug setup so the
# adjacent checksum cannot be mistaken as applying to both executables.
if (-not $DebugBuild) {
    $supersededDebugArtifact = Join-Path $artifactRoot "LectorBit_$($baseConfig.version)_x64-DEBUG-UNSIGNED-setup.exe"
    Assert-OwnedPath -Path $supersededDebugArtifact -OwnedRoot $artifactRoot
    if (Test-Path -LiteralPath $supersededDebugArtifact -PathType Leaf) {
        Remove-Item -LiteralPath $supersededDebugArtifact -Force
    }
}

$artifactHash = Get-Sha256 -Path $artifactPath
[IO.File]::WriteAllText(
    (Join-Path $artifactRoot 'SHA256SUMS.txt'),
    "$artifactHash  $artifactName$([Environment]::NewLine)",
    [Text.UTF8Encoding]::new($false)
)

Write-Host ''
Write-Host 'Installer ready (unsigned local evaluation build).' -ForegroundColor Green
Write-Host "  $artifactPath"
Write-Host "  SHA-256: $artifactHash"
Write-Host ''
Write-Host 'Before installation:' -ForegroundColor Yellow
Write-Host '  1. Use Windows 10 or 11 x64 and keep about 1 GB free.'
Write-Host '  2. Close any running LectorBit window before upgrading.'
Write-Host '  3. Compare the installer hash with SHA256SUMS.txt.'
Write-Host '  4. Expect SmartScreen for this unsigned local build; public builds must be signed.'
Write-Host '  5. After launch, choose a library and install English or Bangla transcription as needed.'
if ($WebViewInstallMode -eq 'downloadBootstrapper') {
    Write-Host '  6. Keep internet available during Setup if Microsoft Edge WebView2 is missing.'
}

#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the pinned whisper.cpp runtime used by LectorBit development builds.
.DESCRIPTION
    Downloads the official whisper.cpp v1.9.2 Windows x64 CPU archive, verifies
    its SHA-256 digest before extraction, and copies only the CLI and its required
    adjacent runtime libraries into Tauri's gitignored sidecar resource folder.

    The upstream MIT license is fetched from the exact same tag and verified
    independently. The process-scoped LECTORBIT_WHISPER_PATH is set only after
    the installed CLI reports the expected version.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'scripts/setup-whisper.ps1 supports Windows only.'
}

$whisperVersion = '1.9.2'
$archiveUri = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip'
$archiveSha256 = '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
$licenseUri = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/LICENSE'
$licenseSha256 = '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
$licenseFilename = 'whisper.cpp-LICENSE.txt'
$runtimeSha256 = [ordered]@{
    'whisper-cli.exe'          = '95e3c0b0e778ad9499eb0125f97c1dcf437dd9eb4ea77050b043574f93c2631d'
    'whisper.dll'              = '792fc523c7ad16e6b9c348e30ad5e5f591165cbcf6a80ca8d0db02a38ce3eea2'
    'ggml.dll'                 = '894c6237ee7849843213906a2b6a0b371aaa6234048d465f206d910ae846fafb'
    'ggml-base.dll'            = '1482359d921b4c1b183d49db1d770f9b5e90d86a618b8b648d4845c2471ad6b0'
    'ggml-cpu-alderlake.dll'   = 'd1c5411561361f7ce71ff8455ecf01f666f581b0608fa91a1dfe7d3fd6a25bd1'
    'ggml-cpu-cannonlake.dll'  = '2ef36f05fa252ff4fdcb8d42ebce1ceba4f3d3de12b93bed15bdee6237dccd63'
    'ggml-cpu-cascadelake.dll' = '505899aaf3f99c5d714361640f561458ea97f8a09eb0614568a66bead2115cb0'
    'ggml-cpu-haswell.dll'     = 'f8cf2f35a06498d783d77fde42004dd54d2f8236b0d42ac323b94bba65a603c4'
    'ggml-cpu-icelake.dll'     = '78ad143ee2e674d037b4840ef33b5748a0659762a26e0ae2b621c4f9451cbde8'
    'ggml-cpu-sandybridge.dll' = 'ee47db7dc40fb30eca73e62a05306059c2c3c42aecddf2e8d6ad7e530069b815'
    'ggml-cpu-skylakex.dll'    = '164e2793897944a43ee071ce6c0b09018088bdf4dd8b14ac0755c58849cf8c50'
    'ggml-cpu-sse42.dll'       = '7318a9a3b95a85b2453c437b274412bbbae89e5ecdf5babb19b99edc06ded063'
    'ggml-cpu-x64.dll'         = 'af0f1c2f28ff9e3f472481dd969907bda85fa39d4fde17617d4bb0b389301b60'
}
$requiredRuntimeFiles = @($runtimeSha256.Keys)

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sidecarDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'lectorbit_backend\src-tauri\resources\sidecars')
)
$installedCli = Join-Path $sidecarDirectory 'whisper-cli.exe'

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-WhisperInstallation {
    foreach ($filename in $requiredRuntimeFiles) {
        $path = Join-Path $sidecarDirectory $filename
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $false
        }
        if ((Get-Sha256 -Path $path) -ne $runtimeSha256[$filename]) {
            return $false
        }
    }
    $installedLicense = Join-Path $sidecarDirectory $licenseFilename
    if (
        -not (Test-Path -LiteralPath $installedLicense -PathType Leaf) -or
        (Get-Sha256 -Path $installedLicense) -ne $licenseSha256
    ) {
        return $false
    }

    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $installedCli
        $startInfo.Arguments = '--version'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $versionOutput = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $process.Dispose()
        if ($exitCode -ne 0) {
            return $false
        }
        return $versionOutput -match "whisper\.cpp version:\s*$([regex]::Escape($whisperVersion))(?:\s|$)"
    } catch {
        return $false
    }
}

function Assert-SafeZipEntries {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$ExtractionRoot
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $resolvedRoot = [System.IO.Path]::GetFullPath($ExtractionRoot)
    $rootPrefix = $resolvedRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        if ($archive.Entries.Count -lt $requiredRuntimeFiles.Count -or $archive.Entries.Count -gt 64) {
            throw "Unexpected number of files in the whisper.cpp archive: $($archive.Entries.Count)."
        }

        $seen = @{}
        foreach ($entry in $archive.Entries) {
            if ([string]::IsNullOrWhiteSpace($entry.FullName) -or $entry.FullName.Contains([char]0)) {
                throw 'The whisper.cpp archive contains an invalid entry name.'
            }
            $entryName = $entry.FullName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $entryPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot $entryName))
            if (-not $entryPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Unsafe path in the whisper.cpp archive: $($entry.FullName)."
            }
            $entryKey = $entry.FullName.ToLowerInvariant()
            if ($seen.ContainsKey($entryKey)) {
                throw "Duplicate path in the whisper.cpp archive: $($entry.FullName)."
            }
            $seen[$entryKey] = $true
        }
    } finally {
        $archive.Dispose()
    }
}

function Remove-OwnedTemporaryDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $temporaryPrefix = $temporaryRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($temporaryPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a non-temporary directory: $resolvedPath"
    }
    if (Test-Path -LiteralPath $resolvedPath) {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}

if (Test-WhisperInstallation) {
    $env:LECTORBIT_WHISPER_PATH = $installedCli
    Write-Host "whisper.cpp $whisperVersion is ready at $installedCli" -ForegroundColor Green
    return
}

$temporaryDirectory = Join-Path (
    [System.IO.Path]::GetTempPath()
) ("lectorbit-whisper-$whisperVersion-" + [guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
    $archivePath = Join-Path $temporaryDirectory 'whisper-bin-x64.zip'
    $extractionRoot = Join-Path $temporaryDirectory 'extracted'
    $licensePath = Join-Path $temporaryDirectory 'LICENSE'

    Write-Host "Downloading whisper.cpp $whisperVersion from the official release..."
    $previousSecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol
    try {
        [System.Net.ServicePointManager]::SecurityProtocol =
            $previousSecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $archiveUri -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri $licenseUri -OutFile $licensePath
    } finally {
        [System.Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
    }

    $actualArchiveSha256 = Get-Sha256 -Path $archivePath
    if ($actualArchiveSha256 -ne $archiveSha256) {
        throw "whisper.cpp archive verification failed. Expected $archiveSha256 but received $actualArchiveSha256."
    }
    $actualLicenseSha256 = Get-Sha256 -Path $licensePath
    if ($actualLicenseSha256 -ne $licenseSha256) {
        throw "whisper.cpp license verification failed. Expected $licenseSha256 but received $actualLicenseSha256."
    }

    New-Item -ItemType Directory -Path $extractionRoot | Out-Null
    Assert-SafeZipEntries -ArchivePath $archivePath -ExtractionRoot $extractionRoot
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractionRoot

    $releaseDirectory = Join-Path $extractionRoot 'Release'
    foreach ($filename in $requiredRuntimeFiles) {
        $source = Join-Path $releaseDirectory $filename
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "The verified whisper.cpp archive is missing required runtime file $filename."
        }
    }

    New-Item -ItemType Directory -Path $sidecarDirectory -Force | Out-Null
    foreach ($filename in $requiredRuntimeFiles) {
        Copy-Item -LiteralPath (Join-Path $releaseDirectory $filename) -Destination (
            Join-Path $sidecarDirectory $filename
        ) -Force
    }
    Copy-Item -LiteralPath $licensePath -Destination (
        Join-Path $sidecarDirectory $licenseFilename
    ) -Force

    if (-not (Test-WhisperInstallation)) {
        throw 'The installed whisper.cpp runtime could not start or reported an unsupported version.'
    }

    $env:LECTORBIT_WHISPER_PATH = $installedCli
    Write-Host "whisper.cpp $whisperVersion installed and verified at $installedCli" -ForegroundColor Green
} finally {
    Remove-OwnedTemporaryDirectory -Path $temporaryDirectory
}

# Media sidecars

LectorBit targets `ffprobe` 8.1.2. Development builds first honor an absolute
`LECTORBIT_FFPROBE_PATH`, then look for `ffprobe` on `PATH`. The executable is
still version-checked before use. Packaged builds do not search `PATH`; they
load the audited executable from `resources/sidecars/ffprobe` (`ffprobe.exe`
on Windows).

Local transcription targets `whisper-cli` 1.9.2. On Windows, use
`dev-setup.ps1`, or run `& .\scripts\setup-whisper.ps1` from an existing
PowerShell session at the repository root. The setup script downloads the
official x64 CPU release, verifies its pinned SHA-256 before extracting it,
keeps the required `whisper` and `ggml` DLLs beside `whisper-cli.exe`, and
installs the exact-tag MIT license. It writes everything to the gitignored
`lectorbit_backend/src-tauri/resources/sidecars` directory and sets
`LECTORBIT_WHISPER_PATH` in the process that invokes it.

Bangla transcription requires a multilingual Whisper model such as
`whisper-base`; model names containing `.en` are English-only. The multilingual
model can transcribe both Bangla (`bn`) and English (`en`). Choose the lecture
language explicitly in Focused Study or the Library before starting transcription.

Sidecar binaries are intentionally not resolved from renderer input or a shell
command. Release artifacts must add the platform artifact, SHA-256, source URL,
and license record to the manifest before packaging. A missing or mismatched
sidecar leaves media indexed with an explicit `unavailable` metadata state;
it never prevents the app from opening.

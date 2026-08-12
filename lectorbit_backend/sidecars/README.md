# Media sidecars

LectorBit targets `ffprobe` 8.1.2. Development builds first honor an absolute
`LECTORBIT_FFPROBE_PATH`, then look for `ffprobe` on `PATH`. The executable is
still version-checked before use. Packaged builds do not search `PATH`; they
load the audited executable from `resources/sidecars/ffprobe` (`ffprobe.exe`
on Windows).

Sidecar binaries are intentionally not resolved from renderer input or a shell
command. Release artifacts must add the platform artifact, SHA-256, source URL,
and license record to the manifest before packaging. A missing or mismatched
sidecar leaves media indexed with an explicit `unavailable` metadata state;
it never prevents the app from opening.

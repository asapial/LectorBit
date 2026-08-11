# LectorBit release runbook

Public builds are created only by `.github/workflows/release.yml` from a semantic `v*` tag. The workflow is intentionally fail-closed: it cannot publish when updater signing, native signing/notarization, or sidecar provenance is incomplete.

## Protected `release` environment

Configure these GitHub environment variables:

- `LECTORBIT_UPDATER_PUBKEY`: the full minisign public key content.
- `LECTORBIT_STABLE_UPDATER_ENDPOINT`: HTTPS URL for stable `latest.json`.
- `LECTORBIT_BETA_UPDATER_ENDPOINT`: HTTPS URL for beta `beta.json`.
- `LECTORBIT_SIDECAR_RELEASE`: immutable release tag containing the three audited sidecar ZIP archives.
- `LECTORBIT_SIDECAR_{WINDOWS,MACOS,LINUX}_X86_64_SHA256`: SHA-256 of each ZIP.
- `APPLE_SIGNING_IDENTITY`: Developer ID Application identity used by Tauri.

Configure these environment secrets:

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for updater artifacts.
- `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD` for Authenticode.
- `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` for signing and notarization.

Never store signing keys, certificate archives, passwords, or temporary release config in Git. The updater public key is expected to be embedded in a public binary; the private key is not.

## Sidecar gate

The external sidecar release must contain these flat ZIP archives:

- `sidecars-x86_64-pc-windows-msvc.zip`
- `sidecars-x86_64-apple-darwin.zip`
- `sidecars-x86_64-unknown-linux-gnu.zip`

Before creating a public tag, add an artifact entry to each checked-in file under `lectorbit_backend/sidecars/manifests/`. Every entry records filename, target triple, architecture, SHA-256, byte size, download/build source, resolved SPDX license, and exact build flags. FFmpeg/ffprobe stay `NOASSERTION` at the source level because their effective license depends on those flags; packaged artifact entries may not use `NOASSERTION`.

Run the same gate locally:

```bash
python scripts/release/verify_provenance.py \
  --manifest-dir lectorbit_backend/sidecars/manifests \
  --model-catalog lectorbit_backend/crates/lectorbit_ai/model-catalog.json \
  --artifact-dir path/to/extracted/sidecars \
  --require-target x86_64-unknown-linux-gnu
```

## Release order

1. CI passes formatting, linting, type checks, Rust/TypeScript tests, DB integration, frontend build, and three-OS desktop smoke.
2. The release preflight validates protected configuration and pinned metadata.
3. Each OS verifies the immutable sidecar archive before bundling.
4. Windows Authenticode signing and macOS Developer ID signing/notarization run in their native jobs.
5. Tauri creates minisign updater artifacts; the workflow reads their `.sig` files into static updater metadata.
6. CI emits checksums, SPDX SBOM, Rust/npm notices, and GitHub build-provenance attestations.
7. The release and `latest.json`/`beta.json` are published only after every matrix job succeeds.

Updater signature verification is performed by Tauri and cannot be disabled for a public build. The in-app install action re-checks the requested version, downloads through the backend, verifies the signature, installs, and relaunches.

References: [Tauri updater](https://v2.tauri.app/plugin/updater/), [Windows signing](https://v2.tauri.app/distribute/sign/windows/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/), and [GitHub release pipelines](https://v2.tauri.app/distribute/pipelines/github/).

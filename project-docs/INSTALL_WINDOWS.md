# Install LectorBit on Windows

LectorBit supports **Windows 10 and Windows 11 on x64 PCs**. The NSIS setup installs for the current Windows user, so administrator access is normally unnecessary. Every complete package includes the local media/transcription runtimes needed by the app. An offline build also embeds Microsoft Edge WebView2; a bootstrapper build downloads WebView2 only when the PC does not already have it.

Windows 7/8, Windows on ARM, and 32-bit Windows are not currently tested or supported. “Windows installer” in this project means Windows 10/11 x64 until those targets have their own build and smoke-test coverage.

## Before installation

1. Keep approximately **1 GB of free disk space** for the app, bundled runtimes, and optional transcript models.
2. Close LectorBit before installing an update. Your library index and study history remain in your local app-data directory.
3. Put the setup executable and `SHA256SUMS.txt` in the same trusted folder. Verify the hash before opening it:

   ```powershell
   Get-FileHash .\LectorBit_0.1.0_x64-UNSIGNED-setup.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS.txt
   ```

4. For a public build, also open the file properties and confirm **Digital Signatures → LectorBit → This digital signature is OK**.
5. Local evaluation builds are deliberately named `UNSIGNED`. Windows SmartScreen can warn about them; do not redistribute an unsigned build as a public release.

## Install

1. Double-click the `LectorBit_*_x64-setup.exe` file.
2. Review the destination shown by Setup, then choose **Install**.
3. Launch LectorBit from the Finish page or Start menu.
4. To install silently for the current user, run `& ".\LectorBit_0.1.0_x64-UNSIGNED-setup.exe" /S` from an authorized deployment script (substitute the current versioned filename).

## First launch

1. Open **Library** and choose the folders that LectorBit is allowed to index.
2. Build a routine from **Plan**. Media stays local and is played through a private loopback stream.
3. In **Focused study**, choose **English** or **বাংলা (Bangla)** before transcription. Each optional language model is about 141 MiB.
4. Configure OpenRouter only if you want grounded cloud study tools. It is optional, and each request still needs session consent.
5. Use **Diagnostics** if metadata parsing, transcription, or playback reports a missing runtime.

## ইনস্টল করার আগে (বাংলা)

1. Windows 10/11 x64 ব্যবহার করুন এবং প্রায় 1 GB খালি জায়গা রাখুন।
2. আপডেট করার আগে LectorBit বন্ধ করুন। আপনার লাইব্রেরি ও পড়াশোনার ইতিহাস ডিভাইসেই থাকবে।
3. `Get-FileHash` দিয়ে setup ফাইলের SHA-256, `SHA256SUMS.txt`-এর মানের সঙ্গে মিলিয়ে নিন।
4. Public release হলে Digital Signatures-এ LectorBit স্বাক্ষরটি valid কিনা দেখুন। `UNSIGNED` local build অন্যদের কাছে বিতরণ করবেন না।
5. প্রথমবার চালু করে Library folder নির্বাচন করুন, তারপর English অথবা বাংলা transcription model ইনস্টল করুন। OpenRouter সম্পূর্ণ optional।

## Build a complete local installer

Prerequisites for the packaging machine:

- Windows 10/11 x64
- Rust 1.97.1 with the MSVC target and Microsoft C++ Build Tools
- Node 24, pnpm 11, and Tauri CLI 2.11
- The pinned Gyan FFmpeg 8.1.2 package available on `PATH`
- Internet access only while building, so Tauri can obtain the offline WebView2 installer and missing verified build tools

From the repository root:

```powershell
.\scripts\build-windows-installer.ps1
```

The script (offline WebView2 by default):

- accepts only the pinned FFmpeg/ffprobe byte hashes and records their complete build configuration;
- verifies every whisper.cpp file against the checked-in v1.9.2 manifest;
- stages resources under the ignored backend target directory and re-hashes every copied byte;
- writes `sidecar-receipt.json` without local usernames or secrets;
- builds a current-user NSIS installer with offline WebView2 in an isolated Cargo target (using practical zlib compression for the large local FFmpeg binaries); and
- copies the setup executable, receipt, and checksum into `artifacts/windows-local/`. A completed release build removes a superseded debug setup from that handoff folder so the checksum is unambiguous.

The packaging script invokes the repository-pinned frontend Tauri CLI rather
than a globally installed `cargo-tauri.exe`. This keeps the build reproducible
and avoids relying on a user-profile Cargo subcommand that Windows Application
Control may block.

The base Tauri configuration also packages `resources/sidecars/`, and its
pre-build hook stages the exact pinned FFmpeg/ffprobe binaries. This prevents a
plain `cargo tauri build` from silently producing an installer that works only
on the build PC because FFmpeg happened to be on that machine's `PATH`.

For a fast provenance check without compiling:

```powershell
.\scripts\build-windows-installer.ps1 -StageOnly
```

If the packaging network blocks Microsoft’s large offline WebView2 download, build the bootstrapper variant instead. Windows 10/11 normally includes WebView2; Setup needs internet only when it is missing:

```powershell
.\scripts\build-windows-installer.ps1 -WebViewInstallMode downloadBootstrapper
```

After a bundle-only network failure, the already-built release binary can be reused without relinking:

```powershell
.\scripts\build-windows-installer.ps1 -WebViewInstallMode downloadBootstrapper -BundleOnly
```

For a faster, explicitly labelled local smoke-test build, add `-DebugBuild`. Use the same switch again with `-BundleOnly`; debug and release binaries are never mixed:

```powershell
.\scripts\build-windows-installer.ps1 -DebugBuild -WebViewInstallMode downloadBootstrapper
```

The local artifact is suitable for evaluation on another Windows 10/11 x64 PC, but it is not a public release. Public release packaging remains fail-closed until canonical FFmpeg provenance/licensing, Authenticode signing, updater signing, and release CI are complete.

Tauri’s current Windows installer reference explains the NSIS and WebView2 modes: <https://v2.tauri.app/distribute/windows-installer/>.

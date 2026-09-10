#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_WINDOWS_BINARIES = new Map([
  [
    "ffmpeg.exe",
    "ad8f211bc894755e0061c55ab280ae00e8d3d4f15a8cc4372b24cfa247b5942e",
  ],
  [
    "ffprobe.exe",
    "9df3b0b5275e830961df6d94e1f7a71121a7abd5ff708e9fec8a0b6084a55015",
  ],
]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const resourceDirectory = join(
  repositoryRoot,
  "lectorbit_backend",
  "src-tauri",
  "resources",
  "sidecars",
);

function regularFile(path) {
  if (!path || !isAbsolute(path) || !existsSync(path)) return false;
  const metadata = lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableCandidates(filename, environmentName) {
  const candidates = [];
  if (process.env[environmentName])
    candidates.push(process.env[environmentName]);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && isAbsolute(directory))
      candidates.push(join(directory, filename));
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    candidates.push(
      join(
        process.env.LOCALAPPDATA,
        "Microsoft",
        "WinGet",
        "Packages",
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
        "ffmpeg-8.1.2-full_build",
        "bin",
        filename,
      ),
    );
  }
  candidates.push(join(resourceDirectory, filename));
  return candidates;
}

function resolvePinnedWindowsBinary(filename, environmentName) {
  const expected = EXPECTED_WINDOWS_BINARIES.get(filename);
  for (const candidate of executableCandidates(filename, environmentName)) {
    if (!regularFile(candidate)) continue;
    const path = realpathSync(candidate);
    if (sha256(path) === expected) return path;
  }
  throw new Error(
    `${filename} is missing or does not match LectorBit's pinned FFmpeg 8.1.2 build. ` +
      `Install Gyan.FFmpeg 8.1.2 or set ${environmentName} to the verified absolute path.`,
  );
}

function distributionRoot(binaryPath) {
  const binaryDirectory = dirname(binaryPath);
  return resolve(binaryDirectory) === resolve(resourceDirectory)
    ? resourceDirectory
    : dirname(binaryDirectory);
}

function copyVerified(source, destination, expectedHash = undefined) {
  if (!regularFile(source))
    throw new Error(`Required runtime file is missing: ${source}`);
  const sourceHash = sha256(source);
  if (expectedHash && sourceHash !== expectedHash) {
    throw new Error(`Runtime hash verification failed for ${source}`);
  }
  if (resolve(source) !== resolve(destination))
    copyFileSync(source, destination);
  if (sha256(destination) !== sourceHash) {
    throw new Error(`Post-copy verification failed for ${destination}`);
  }
}

function stageWindowsRuntime() {
  const ffmpeg = resolvePinnedWindowsBinary(
    "ffmpeg.exe",
    "LECTORBIT_FFMPEG_PATH",
  );
  const ffprobe = resolvePinnedWindowsBinary(
    "ffprobe.exe",
    "LECTORBIT_FFPROBE_PATH",
  );
  const ffmpegRoot = distributionRoot(ffmpeg);
  const ffprobeRoot = distributionRoot(ffprobe);
  if (
    resolve(ffmpegRoot).toLowerCase() !== resolve(ffprobeRoot).toLowerCase()
  ) {
    throw new Error(
      "ffmpeg.exe and ffprobe.exe must come from the same verified distribution.",
    );
  }

  const sourceLicense =
    resolve(ffmpegRoot) === resolve(resourceDirectory)
      ? join(resourceDirectory, "FFmpeg-LICENSE.txt")
      : join(ffmpegRoot, "LICENSE");
  const sourceReadme =
    resolve(ffmpegRoot) === resolve(resourceDirectory)
      ? join(resourceDirectory, "FFmpeg-README.txt")
      : join(ffmpegRoot, "README.txt");

  mkdirSync(resourceDirectory, { recursive: true });
  copyVerified(
    ffmpeg,
    join(resourceDirectory, "ffmpeg.exe"),
    EXPECTED_WINDOWS_BINARIES.get("ffmpeg.exe"),
  );
  copyVerified(
    ffprobe,
    join(resourceDirectory, "ffprobe.exe"),
    EXPECTED_WINDOWS_BINARIES.get("ffprobe.exe"),
  );
  copyVerified(sourceLicense, join(resourceDirectory, "FFmpeg-LICENSE.txt"));
  copyVerified(sourceReadme, join(resourceDirectory, "FFmpeg-README.txt"));
  console.log(`Verified packaged FFmpeg runtime in ${resourceDirectory}`);
}

function verifyPreparedRuntime() {
  for (const filename of ["ffmpeg", "ffprobe"]) {
    const path = join(resourceDirectory, filename);
    if (!regularFile(path)) {
      throw new Error(
        `Packaged ${filename} is missing from ${resourceDirectory}. ` +
          "Release automation must stage the verified target sidecars before invoking Tauri.",
      );
    }
  }
  console.log(`Verified packaged media runtime in ${resourceDirectory}`);
}

if (process.platform === "win32") {
  stageWindowsRuntime();
} else {
  verifyPreparedRuntime();
}

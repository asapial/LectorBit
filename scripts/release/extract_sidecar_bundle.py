#!/usr/bin/env python3
"""Verify and safely extract a flat, pre-audited sidecar ZIP archive."""

from __future__ import annotations

import argparse
import hashlib
import re
import stat
import sys
import zipfile
from pathlib import Path

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_BUNDLE_FILES = 32


def extract(archive: Path, expected_sha256: str, destination: Path) -> None:
    if not SHA256_RE.fullmatch(expected_sha256):
        raise ValueError("bundle checksum must be 64 lowercase hexadecimal characters")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise ValueError("sidecar bundle SHA-256 does not match the protected release value")
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        files = [entry for entry in bundle.infolist() if not entry.is_dir()]
        if not files or len(files) > MAX_BUNDLE_FILES:
            raise ValueError(
                f"sidecar bundle must contain between 1 and {MAX_BUNDLE_FILES} files"
            )
        seen: set[str] = set()
        for entry in files:
            name = Path(entry.filename)
            unix_mode = entry.external_attr >> 16
            if (
                name.name != entry.filename
                or entry.filename in {".", ".."}
                or name.name.casefold() in seen
                or stat.S_ISLNK(unix_mode)
                or entry.file_size > 1_500_000_000
            ):
                raise ValueError(f"unsafe sidecar archive entry: {entry.filename}")
            seen.add(name.name.casefold())
            target = destination / name.name
            with bundle.open(entry) as source, target.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
            if sys.platform != "win32":
                target.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        extract(args.archive, args.sha256, args.destination)
    except (OSError, zipfile.BadZipFile, ValueError) as error:
        print(f"sidecar bundle error: {error}", file=sys.stderr)
        return 1
    print(f"verified and extracted sidecars to {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

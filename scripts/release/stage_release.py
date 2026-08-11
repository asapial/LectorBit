#!/usr/bin/env python3
"""Collect a Tauri bundle and create one signed updater descriptor."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

from generate_updater_manifest import descriptor


def stage(
    bundle_dir: Path,
    output: Path,
    version: str,
    platform: str,
    base_url: str,
    notes: str,
    pub_date: str,
) -> None:
    signatures = sorted(bundle_dir.rglob("*.sig"))
    signed = [(signature, Path(str(signature)[: -len(".sig")])) for signature in signatures]
    signed = [(signature, artifact) for signature, artifact in signed if artifact.is_file()]
    if len(signed) != 1:
        raise ValueError(f"expected exactly one signed updater artifact, found {len(signed)}")
    signature, updater_artifact = signed[0]
    output.mkdir(parents=True, exist_ok=True)
    copied: set[str] = set()

    def copy(source: Path) -> Path:
        if source.name.casefold() in copied:
            raise ValueError(f"duplicate release artifact name: {source.name}")
        copied.add(source.name.casefold())
        target = output / source.name
        shutil.copy2(source, target)
        return target

    staged_updater = copy(updater_artifact)
    copy(signature)
    native_suffixes = {".msi", ".exe", ".dmg", ".appimage", ".deb", ".rpm"}
    for candidate in sorted(bundle_dir.rglob("*")):
        if (
            candidate.is_file()
            and candidate not in {updater_artifact, signature}
            and candidate.suffix.lower() in native_suffixes
        ):
            copy(candidate)

    document = descriptor(
        SimpleNamespace(
            artifact=staged_updater,
            version=version,
            platform=platform,
            base_url=base_url,
            notes=notes,
            pub_date=pub_date,
        )
    )
    descriptor_path = output / f"updater-{platform}.json"
    import json

    descriptor_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    checksum_lines = []
    for artifact in sorted(path for path in output.iterdir() if path.is_file()):
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        checksum_lines.append(f"{digest}  {artifact.name}")
    (output / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument("--pub-date", required=True)
    args = parser.parse_args()
    try:
        stage(
            args.bundle_dir,
            args.output,
            args.version,
            args.platform,
            args.base_url,
            args.notes,
            args.pub_date,
        )
    except (OSError, ValueError) as error:
        print(f"release staging error: {error}", file=sys.stderr)
        return 1
    print(f"staged signed release artifacts: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

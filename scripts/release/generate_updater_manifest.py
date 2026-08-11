#!/usr/bin/env python3
"""Generate and merge Tauri static updater metadata from signed artifacts."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse


class ManifestError(ValueError):
    pass


def valid_https(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def descriptor(args: argparse.Namespace) -> dict:
    artifact = args.artifact.resolve()
    signature_path = Path(f"{artifact}.sig")
    if not artifact.is_file() or not signature_path.is_file():
        raise ManifestError("updater artifact and adjacent .sig file are required")
    signature = signature_path.read_text(encoding="utf-8").strip()
    if len(signature) < 32 or "PLACEHOLDER" in signature.upper():
        raise ManifestError("updater signature is empty or a placeholder")
    if not valid_https(args.base_url):
        raise ManifestError("base URL must use HTTPS")
    version = args.version.removeprefix("v")
    if not version or len(version) > 64:
        raise ManifestError("invalid release version")
    platform = args.platform.strip()
    if platform not in {
        "windows-x86_64",
        "linux-x86_64",
        "darwin-x86_64",
        "darwin-aarch64",
    }:
        raise ManifestError(f"unsupported updater platform: {platform}")
    return {
        "version": version,
        "notes": args.notes.strip(),
        "pub_date": args.pub_date,
        "platforms": {
            platform: {
                "signature": signature,
                "url": f"{args.base_url.rstrip('/')}/{quote(artifact.name)}",
            }
        },
    }


def merge(paths: list[Path]) -> dict:
    documents = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    if not documents:
        raise ManifestError("at least one descriptor is required")
    version = documents[0].get("version")
    notes = documents[0].get("notes", "")
    pub_date = documents[0].get("pub_date")
    platforms: dict = {}
    for document in documents:
        if document.get("version") != version:
            raise ManifestError("all descriptors must use the same version")
        entries = document.get("platforms")
        if not isinstance(entries, dict) or len(entries) != 1:
            raise ManifestError("each descriptor must contain exactly one platform")
        for platform, entry in entries.items():
            if platform in platforms:
                raise ManifestError(f"duplicate updater platform: {platform}")
            if not isinstance(entry, dict) or not valid_https(entry.get("url", "")):
                raise ManifestError(f"invalid updater entry for {platform}")
            if len(entry.get("signature", "")) < 32:
                raise ManifestError(f"missing updater signature for {platform}")
            platforms[platform] = entry
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": dict(sorted(platforms.items())),
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("descriptor")
    create.add_argument("--version", required=True)
    create.add_argument("--platform", required=True)
    create.add_argument("--artifact", type=Path, required=True)
    create.add_argument("--base-url", required=True)
    create.add_argument("--notes", default="")
    create.add_argument(
        "--pub-date", default=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    )
    create.add_argument("--output", type=Path, required=True)
    combine = subparsers.add_parser("merge")
    combine.add_argument("inputs", nargs="+", type=Path)
    combine.add_argument("--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        document = descriptor(args) if args.command == "descriptor" else merge(args.inputs)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, ManifestError) as error:
        print(f"updater manifest error: {error}", file=sys.stderr)
        return 1
    print(f"wrote signed updater metadata: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

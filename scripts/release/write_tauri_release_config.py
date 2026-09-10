#!/usr/bin/env python3
"""Write the non-secret Tauri release overlay after signing material is installed."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def release_overlay(updater_pubkey: str, windows_thumbprint: str | None = None) -> dict:
    """Return a release-only overlay; local/base builds never emit updater artifacts."""
    updater_pubkey = updater_pubkey.strip()
    if not updater_pubkey:
        raise ValueError("the updater public key is required for a release build")
    bundle: dict = {
        "createUpdaterArtifacts": True,
    }
    if windows_thumbprint:
        bundle["windows"] = {
            "certificateThumbprint": windows_thumbprint,
            "digestAlgorithm": "sha256",
            "timestampUrl": "http://timestamp.digicert.com",
        }
    return {
        "plugins": {"updater": {"pubkey": updater_pubkey}},
        "bundle": bundle,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--updater-pubkey", default=os.environ.get("LECTORBIT_UPDATER_PUBKEY")
    )
    parser.add_argument(
        "--windows-thumbprint", default=os.environ.get("WINDOWS_CERTIFICATE_THUMBPRINT")
    )
    args = parser.parse_args()
    try:
        overlay = release_overlay(args.updater_pubkey or "", args.windows_thumbprint)
    except ValueError as error:
        parser.error(str(error))
    args.output.write_text(json.dumps(overlay, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

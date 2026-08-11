#!/usr/bin/env python3
"""Write the non-secret Tauri release overlay after signing material is installed."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--windows-thumbprint", default=os.environ.get("WINDOWS_CERTIFICATE_THUMBPRINT")
    )
    args = parser.parse_args()
    bundle: dict = {
        "resources": {"resources/sidecars/": "sidecars/"},
    }
    if args.windows_thumbprint:
        bundle["windows"] = {
            "certificateThumbprint": args.windows_thumbprint,
            "digestAlgorithm": "sha256",
            "timestampUrl": "http://timestamp.digicert.com",
        }
    args.output.write_text(json.dumps({"bundle": bundle}, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

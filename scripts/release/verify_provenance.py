#!/usr/bin/env python3
"""Validate pinned model/sidecar provenance and optionally verify package bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TARGET_RE = re.compile(r"^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_.-]+$")


class ProvenanceError(ValueError):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProvenanceError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ProvenanceError(f"{path}: top level must be an object")
    return value


def required_text(value: dict[str, Any], key: str, path: Path) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip():
        raise ProvenanceError(f"{path}: {key} must be a non-empty string")
    return result.strip()


def require_https(value: str, label: str, path: Path) -> None:
    if not value.startswith("https://") or "example.invalid" in value:
        raise ProvenanceError(f"{path}: {label} must be a pinned HTTPS source")


def validate_model_catalog(path: Path) -> dict[str, Any]:
    catalog = read_json(path)
    if catalog.get("schema_version") != 1:
        raise ProvenanceError(f"{path}: unsupported schema_version")
    required_text(catalog, "catalog_version", path)
    models = catalog.get("models")
    if not isinstance(models, list) or not models:
        raise ProvenanceError(f"{path}: models must be a non-empty array")
    seen: set[str] = set()
    for index, model in enumerate(models):
        label = f"{path}: models[{index}]"
        if not isinstance(model, dict):
            raise ProvenanceError(f"{label} must be an object")
        model_id = required_text(model, "id", path)
        if model_id in seen:
            raise ProvenanceError(f"{path}: duplicate model id {model_id}")
        seen.add(model_id)
        for key in ("version", "provider", "architecture", "analyzer_compatibility", "license"):
            required_text(model, key, path)
        source = required_text(model, "source_url", path)
        require_https(source, "source_url", path)
        size = model.get("expected_size_bytes")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ProvenanceError(f"{label}: expected_size_bytes must be positive")
        digest = required_text(model, "sha256", path)
        if not SHA256_RE.fullmatch(digest):
            raise ProvenanceError(f"{label}: sha256 must be lowercase hexadecimal")
    return catalog


def validate_sidecar_manifest(
    path: Path, artifact_root: Path | None, required_target: str | None
) -> dict[str, Any]:
    manifest = read_json(path)
    if manifest.get("schema_version") != 1 or manifest.get("kind") != "sidecar":
        raise ProvenanceError(f"{path}: unsupported sidecar manifest")
    component = required_text(manifest, "component", path)
    for key in ("version", "source_revision", "license_spdx", "license_note"):
        required_text(manifest, key, path)
    source = required_text(manifest, "source", path)
    require_https(source, "source", path)
    targets = manifest.get("supported_targets")
    if not isinstance(targets, list) or not targets:
        raise ProvenanceError(f"{path}: supported_targets must be a non-empty array")
    if len(set(targets)) != len(targets) or not all(
        isinstance(target, str) and TARGET_RE.fullmatch(target) for target in targets
    ):
        raise ProvenanceError(f"{path}: supported_targets contains invalid or duplicate triples")
    if required_target and required_target not in targets:
        raise ProvenanceError(f"{path}: {required_target} is not supported")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise ProvenanceError(f"{path}: artifacts must be an array")
    seen: set[tuple[str, str]] = set()
    matched_target = False
    for index, artifact in enumerate(artifacts):
        label = f"{path}: artifacts[{index}]"
        if not isinstance(artifact, dict):
            raise ProvenanceError(f"{label} must be an object")
        filename = required_text(artifact, "filename", path)
        if filename != Path(filename).name or filename in {".", ".."}:
            raise ProvenanceError(f"{label}: filename must be a basename")
        target = required_text(artifact, "target_triple", path)
        if target not in targets:
            raise ProvenanceError(f"{label}: target_triple is not supported")
        architecture = required_text(artifact, "architecture", path)
        digest = required_text(artifact, "sha256", path)
        if not SHA256_RE.fullmatch(digest):
            raise ProvenanceError(f"{label}: sha256 must be lowercase hexadecimal")
        size = artifact.get("size_bytes")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ProvenanceError(f"{label}: size_bytes must be positive")
        artifact_license = required_text(artifact, "license_spdx", path)
        if artifact_license == "NOASSERTION":
            raise ProvenanceError(f"{label}: packaged artifact license must be resolved")
        required_text(artifact, "build_flags", path)
        artifact_source = required_text(artifact, "source", path)
        require_https(artifact_source, "artifact source", path)
        key = (target, filename.casefold())
        if key in seen:
            raise ProvenanceError(f"{label}: duplicate target/filename")
        seen.add(key)
        if required_target == target:
            matched_target = True
        if artifact_root is not None and (required_target is None or required_target == target):
            verify_artifact(artifact_root, filename, size, digest, label)

    if required_target and not matched_target:
        raise ProvenanceError(
            f"{path}: {component} has no packaged artifact for {required_target}; release blocked"
        )
    return manifest


def verify_artifact(root: Path, filename: str, size: int, digest: str, label: str) -> None:
    resolved_root = root.resolve()
    candidate = (resolved_root / filename).resolve()
    if candidate.parent != resolved_root or not candidate.is_file() or candidate.is_symlink():
        raise ProvenanceError(f"{label}: artifact file is missing or unsafe")
    if candidate.stat().st_size != size:
        raise ProvenanceError(f"{label}: artifact size does not match manifest")
    hasher = hashlib.sha256()
    with candidate.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    if hasher.hexdigest() != digest:
        raise ProvenanceError(f"{label}: artifact SHA-256 does not match manifest")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-dir", type=Path, required=True)
    parser.add_argument("--model-catalog", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path)
    parser.add_argument("--require-target")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        validate_model_catalog(args.model_catalog)
        manifests = sorted(args.manifest_dir.glob("*.json"))
        if not manifests:
            raise ProvenanceError(f"{args.manifest_dir}: no sidecar manifests")
        components: set[str] = set()
        for manifest_path in manifests:
            manifest = validate_sidecar_manifest(
                manifest_path, args.artifact_dir, args.require_target
            )
            component = manifest["component"]
            if component in components:
                raise ProvenanceError(f"duplicate sidecar component: {component}")
            components.add(component)
        expected = {"ffmpeg", "ffprobe", "mpv", "whisper-cli"}
        if components != expected:
            raise ProvenanceError(
                f"sidecar set mismatch: expected {sorted(expected)}, got {sorted(components)}"
            )
    except ProvenanceError as error:
        print(f"provenance error: {error}", file=sys.stderr)
        return 1
    print(
        f"provenance valid: {len(manifests)} sidecars, "
        f"model catalog {args.model_catalog.name}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

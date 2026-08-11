from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


provenance = load("verify_provenance", ROOT / "scripts/release/verify_provenance.py")
updater = load("generate_updater_manifest", ROOT / "scripts/release/generate_updater_manifest.py")
sidecars = load("extract_sidecar_bundle", ROOT / "scripts/release/extract_sidecar_bundle.py")


class ProvenanceTests(unittest.TestCase):
    def test_repository_catalog_and_sidecar_metadata_are_valid(self):
        provenance.validate_model_catalog(
            ROOT / "lectorbit_backend/crates/lectorbit_ai/model-catalog.json"
        )
        for path in (ROOT / "lectorbit_backend/sidecars/manifests").glob("*.json"):
            provenance.validate_sidecar_manifest(path, None, None)

    def test_artifact_hash_is_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / "tool.bin"
            payload.write_bytes(b"verified")
            provenance.verify_artifact(
                root,
                payload.name,
                payload.stat().st_size,
                hashlib.sha256(payload.read_bytes()).hexdigest(),
                "test",
            )
            with self.assertRaises(provenance.ProvenanceError):
                provenance.verify_artifact(root, payload.name, 1, "0" * 64, "test")


class UpdaterManifestTests(unittest.TestCase):
    def test_merge_rejects_duplicate_platforms(self):
        document = {
            "version": "1.0.0",
            "notes": "Release",
            "pub_date": "2026-08-12T00:00:00Z",
            "platforms": {
                "windows-x86_64": {
                    "signature": "s" * 64,
                    "url": "https://downloads.example.com/app.zip",
                }
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "one.json"
            second = Path(directory) / "two.json"
            first.write_text(json.dumps(document), encoding="utf-8")
            second.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(updater.ManifestError):
                updater.merge([first, second])


class SidecarBundleTests(unittest.TestCase):
    def test_archive_path_traversal_is_rejected(self):
        import zipfile

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "sidecars.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape", b"bad")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            with self.assertRaises(ValueError):
                sidecars.extract(archive, digest, root / "output")


if __name__ == "__main__":
    unittest.main()

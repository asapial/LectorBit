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

    def test_whisper_manifest_audits_only_the_packaged_windows_target(self):
        manifest = json.loads(
            (
                ROOT
                / "lectorbit_backend/sidecars/manifests/whisper-cli-1.9.2.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            manifest["supported_targets"], ["x86_64-pc-windows-msvc"]
        )

        artifacts = {
            artifact["filename"]: artifact for artifact in manifest["artifacts"]
        }
        self.assertEqual(
            artifacts["whisper.cpp-LICENSE.txt"],
            {
                "filename": "whisper.cpp-LICENSE.txt",
                "target_triple": "x86_64-pc-windows-msvc",
                "architecture": "x86_64",
                "sha256": "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d",
                "size_bytes": 1078,
                "license_spdx": "MIT",
                "build_flags": "not applicable; exact upstream v1.9.2 license text",
                "source": "https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.2/LICENSE",
            },
        )


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
    @staticmethod
    def _write_bundle(archive: Path, filenames: list[str]) -> str:
        import zipfile

        with zipfile.ZipFile(archive, "w") as bundle:
            for filename in filenames:
                bundle.writestr(filename, filename.encode("utf-8"))
        return hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_complete_windows_sidecar_set_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "sidecars.zip"
            filenames = [
                "ffmpeg.exe",
                "ffprobe.exe",
                "mpv.exe",
                "whisper-cli.exe",
                "whisper.dll",
                "ggml.dll",
                "ggml-base.dll",
                "ggml-cpu-alderlake.dll",
                "ggml-cpu-cannonlake.dll",
                "ggml-cpu-cascadelake.dll",
                "ggml-cpu-haswell.dll",
                "ggml-cpu-icelake.dll",
                "ggml-cpu-sandybridge.dll",
                "ggml-cpu-skylakex.dll",
                "ggml-cpu-sse42.dll",
                "ggml-cpu-x64.dll",
                "whisper.cpp-LICENSE.txt",
            ]
            digest = self._write_bundle(archive, filenames)

            destination = root / "output"
            sidecars.extract(archive, digest, destination)

            self.assertEqual(
                sorted(path.name for path in destination.iterdir()), sorted(filenames)
            )

    def test_bundle_file_limit_remains_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "sidecars.zip"
            filenames = [
                f"runtime-{index}.bin"
                for index in range(sidecars.MAX_BUNDLE_FILES + 1)
            ]
            digest = self._write_bundle(archive, filenames)

            with self.assertRaisesRegex(ValueError, "between 1 and 32 files"):
                sidecars.extract(archive, digest, root / "output")

    def test_archive_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "sidecars.zip"
            digest = self._write_bundle(archive, ["../escape"])
            with self.assertRaises(ValueError):
                sidecars.extract(archive, digest, root / "output")


if __name__ == "__main__":
    unittest.main()

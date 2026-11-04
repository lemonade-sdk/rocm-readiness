"""Fresh consumer snapshots follow producer-backed current ROCm tracks."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.collect import collect
from scripts.conformance import validate_dataset
from scripts.validation import PipelineValidationError
from tests.test_collect import fixture


class CurrentTracksTests(unittest.TestCase):
    def config(self):
        return {
            "schema_version": 1,
            "engines": [
                {
                    "id": "llamacpp",
                    "label": "llama.cpp",
                    "platforms": ["linux", "windows"],
                }
            ],
            "readiness": {"stable_anchor": "latest", "nightly_limit": 2},
            "sources": [
                {
                    "id": "stable",
                    "engine": "llamacpp",
                    "adapter": "qualification-v1",
                    "repository": "lemonade-sdk/llama.cpp",
                    "ref": "qualification-data",
                    "path": "qualification/index.json",
                    "channel": "stable",
                    "stale_after_hours": 72,
                },
                {
                    "id": "nightly",
                    "engine": "llamacpp",
                    "adapter": "qualification-v1",
                    "repository": "lemonade-sdk/llamacpp-rocm",
                    "ref": "qualification-data",
                    "path": "qualification/index.json",
                    "channel": "nightly",
                    "stale_after_hours": 72,
                },
            ],
        }

    def run_collection(
        self,
        root,
        stable=("10.0", "10.1"),
        nightly=("10.2.0a20261027", "10.3.0a20261027", "10.10.0a20261027"),
        previous=None,
        performance=False,
    ):
        def document(versions, is_nightly):
            d = fixture("llama.json")
            d["repo"] = (
                "lemonade-sdk/llamacpp-rocm" if is_nightly else "lemonade-sdk/llama.cpp"
            )
            template = d["builds"][0]
            d["builds"] = []
            for i, version in enumerate(versions):
                row = copy.deepcopy(template)
                row.update(
                    build_id=f"build-{version}",
                    rocm_version=version,
                    report_url=f"reports/{i}.json",
                )
                if is_nightly:
                    row.update(
                        tag=None,
                        build_result="fail",
                        published=False,
                        qualified=False,
                        overall="fail",
                        blocked_by=["build failed"],
                    )
                d["builds"].append(row)
            return d

        docs = {False: document(stable, False), True: document(nightly, True)}

        config = self.config()
        if performance:
            from tests.test_attribution import evidence
            import hashlib

            perf = fixture("performance.json")
            perf["history"] = {}
            config["sources"].append(
                {
                    "id": "performance",
                    "engine": "llamacpp",
                    "adapter": "lemonade-leaderboard-v1",
                    "repository": "lemonade-sdk/lemonade",
                    "ref": "benchmark-data",
                    "path": "leaderboard.json",
                    "channel": "from-record",
                    "stale_after_hours": 72,
                    "execution_details": False,
                    "include_forks": ["llamacpp-rocm-nightly"],
                    "forks": {
                        "llamacpp-rocm-nightly": {
                            "engine": "llamacpp",
                            "channel": "nightly",
                            "backend": "rocm",
                            "repository": "lemonade-sdk/llamacpp-rocm",
                        }
                    },
                }
            )
            body = "**ROCm Version**: 10.3.0a20261027\n"
            proof = evidence(
                run_id="40459300755",
                fork_id="llamacpp-rocm-nightly",
                engine_repository="lemonade-sdk/llamacpp-rocm",
                engine_version="b1355",
                started_at="2026-10-27T00:00:00Z",
                completed_at="2026-10-27T23:59:59Z",
                evidence_url="https://github.com/lemonade-sdk/lemonade/actions/runs/40459300755/job/99",
                package_url="https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b1355/llama-b1355-ubuntu-rocm-gfx1151-x64.zip",
                runtime_evidence={
                    "url": "https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases/tags/b1355",
                    "body": body,
                    "sha256": hashlib.sha256(body.encode()).hexdigest(),
                },
            )

        def fetch(url):
            if "/commits/" in url:
                return {"sha": "a" * 40}
            if url.endswith("/qualification/index.json"):
                return docs["llamacpp-rocm" in url]
            if performance and url.endswith("leaderboard.json"):
                return perf
            raise AssertionError(url)

        return collect(
            config,
            root,
            fetch=fetch,
            now="2026-10-29T12:00:00Z",
            previous_data=previous,
            package_evidence=[proof] if performance else None,
        )

    def test_selects_next_two_tracks_numerically_and_preserves_exact_failed_sdk(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            out = self.run_collection(root)
            self.assertEqual(
                [v["rocm_version"] for v in out["dataset"]["versions"]],
                ["10.1", "10.2.0", "10.3.0"],
            )
            nightly = [r for r in out["builds"] if r["channel"] == "nightly"]
            self.assertEqual(
                [r["producer_rocm_version"] for r in nightly],
                ["10.2.0a20261027", "10.3.0a20261027"],
            )
            self.assertTrue(
                all(
                    r["qualified"] is False
                    and r["published"] is False
                    and r["build_result"] == "fail"
                    for r in nightly
                )
            )
            validate_dataset(root, self.config(), check_live_pointer=False)

    def test_zero_or_one_nightly_track_does_not_invent_another(self):
        for versions, expected in [
            ((), ["10.1"]),
            (("10.3.0a20261027",), ["10.1", "10.3.0"]),
        ]:
            with (
                self.subTest(versions=versions),
                tempfile.TemporaryDirectory() as folder,
            ):
                out = self.run_collection(Path(folder), nightly=versions)
                self.assertEqual(
                    [v["rocm_version"] for v in out["dataset"]["versions"]], expected
                )

    def test_rollover_and_previous_snapshot_do_not_resurrect_old_rows(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.run_collection(root / "old")
            out = self.run_collection(
                root / "new",
                stable=("10.2",),
                nightly=("10.3.0a20261028",),
                previous=root / "old",
            )
            self.assertEqual(
                [v["rocm_version"] for v in out["dataset"]["versions"]],
                ["10.2", "10.3.0"],
            )
            history = json.loads(
                (root / "new/rocm/10.3.0/history/2026-10.json").read_text()
            )
            self.assertEqual(
                [b["producer_rocm_version"] for b in history["builds"]],
                ["10.3.0a20261028"],
            )

    def test_published_runtime_without_raw_copies_still_validates(self):
        import shutil
        from scripts.publish import manifest

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.run_collection(root / "collected")
            runtime = root / "published"
            for relative in manifest(root / "collected"):
                dest = runtime / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / "collected" / relative, dest)
            self.assertFalse((runtime / "raw").exists())
            published_index = json.loads((runtime / "index.json").read_text())
            for source in published_index["sources"]:
                source.pop("snapshot", None)
            (runtime / "index.json").write_text(json.dumps(published_index))
            validate_dataset(runtime, self.config(), check_live_pointer=False)

    def test_nightly_performance_and_execution_keep_verified_numeric_sdk_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            out = self.run_collection(
                root, nightly=("10.3.0a20261027",), performance=True
            )
            self.assertEqual(out["measurements"][0]["rocm_version"], "10.3.0")
            self.assertEqual(
                out["measurements"][0]["runtime_version"], "10.3.0a20261027"
            )
            from tests.test_execution_dataset import attempt
            from scripts.execution_dataset import summarize, validate_execution_file

            row = attempt()
            for field in (
                "channel",
                "fork_id",
                "engine_repository",
                "engine_version",
                "rocm_version",
                "package_url",
                "package_os",
                "attribution",
                "runtime_version",
                "measured_at",
                "run_id",
                "run_url",
            ):
                row[field] = out["measurements"][0][field]
            validate_execution_file(
                {
                    "schema_version": 1,
                    "rocm_version": "10.3.0",
                    "attempts": [row],
                    "summaries": summarize([row]),
                },
                "10.3.0",
            )
            self.assertEqual(
                [v["rocm_version"] for v in out["dataset"]["versions"]],
                ["10.1", "10.3.0"],
            )
            validate_dataset(root, check_live_pointer=False)

    def test_missing_stable_evidence_cannot_guess_anchor(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, "stable"):
                self.run_collection(Path(folder), stable=())

    def test_conformance_rejects_selection_not_backed_by_current_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.run_collection(root)
            path = root / "index.json"
            d = json.loads(path.read_text())
            d["readiness"]["tracks"].append("10.10")
            path.write_text(json.dumps(d))
            with self.assertRaises(PipelineValidationError):
                validate_dataset(root, self.config(), check_live_pointer=False)

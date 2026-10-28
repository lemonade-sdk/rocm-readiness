import copy
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

from scripts.collect import collect, normalize_qualification, normalize_performance
from scripts.validation import PipelineValidationError

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class QualificationTests(unittest.TestCase):
    def test_qualification_diagnostic_has_exact_field_and_record(self):
        data = fixture("llama.json")
        del data["builds"][0]["tag"]
        with self.assertRaises(PipelineValidationError) as raised:
            normalize_qualification(
                {"id": "llama", "engine": "llamacpp", "channel": "stable"},
                data,
                "https://example.com/index.json",
            )
        self.assertEqual(raised.exception.diagnostic["record"], "/builds/0")
        self.assertEqual(raised.exception.diagnostic["field"], "tag")

    def test_qualification_requires_test_counts(self):
        for field in ("passed", "failed", "total"):
            data = fixture("llama.json")
            del data["builds"][0]["tests"][field]
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_qualification(
                    {"id": "llama", "engine": "llamacpp", "channel": "stable"},
                    data,
                    "https://example.com/index.json",
                )
            self.assertEqual(raised.exception.diagnostic["field"], f"tests/{field}")

    def test_qualification_projection_types_have_source_context(self):
        for field, value, expected in (
            ("artifact", [], "artifact"),
            ("gfx_target", {}, "gfx_target"),
            ("gfx", {"requested": -1}, "gfx/requested"),
            ("gfx", {"missing": [1]}, "gfx/missing"),
            ("blocked_by", [1], "blocked_by"),
            ("blocking_tests", "bad", "blocking_tests"),
        ):
            data = fixture("llama.json")
            data["builds"][0][field] = value
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_qualification(
                    {"id": "llama", "engine": "llamacpp", "channel": "stable"},
                    data,
                    "https://example.com/index.json",
                )
            self.assertEqual(raised.exception.diagnostic["field"], expected)
            self.assertEqual(raised.exception.diagnostic["record"], "/builds/0")

    def test_preserves_producer_gate_despite_warnings_and_missing_tests(self):
        source = {
            "id": "llama",
            "engine": "llamacpp",
            "channel": "stable",
            "adapter": "qualification-v1",
            "os": None,
        }
        data = fixture("llama.json")
        data["builds"][0]["overall"] = "warn"
        data["builds"][0]["results"]["T1.1"] = "missing"
        rows = normalize_qualification(
            source,
            data,
            "https://raw.githubusercontent.com/a/b/abc/qualification/index.json",
        )
        self.assertTrue(rows[0]["qualified"])
        self.assertEqual(rows[0]["os"], "linux")
        self.assertEqual(rows[0]["hardware_validated"], True)
        self.assertIn("/abc/qualification/reports/", rows[0]["report_url"])

    def test_vllm_keeps_historical_nightly_channel_and_unknown_hardware_validation(
        self,
    ):
        source = {
            "id": "vllm",
            "engine": "vllm",
            "channel": "from-record",
            "adapter": "qualification-v1",
            "os": "linux",
        }
        rows = normalize_qualification(
            source,
            fixture("vllm.json"),
            "https://raw.githubusercontent.com/a/b/abc/qualification/index.json",
        )
        self.assertEqual(rows[1]["channel"], "nightly")
        self.assertIsNone(rows[1]["hardware_validated"])
        self.assertTrue(rows[1]["qualified"])
        self.assertGreater(rows[1]["tests"]["failed"], 0)

    def test_rejects_unknown_schema_and_non_boolean_verdict(self):
        source = {"id": "x", "engine": "llamacpp", "channel": "stable", "os": None}
        data = fixture("llama.json")
        data["schema_version"] = 2
        with self.assertRaisesRegex(ValueError, "schema_version"):
            normalize_qualification(source, data, "https://example.com/index.json")
        data["schema_version"] = 1
        data["builds"][0]["qualified"] = "false"
        with self.assertRaisesRegex(ValueError, "qualified"):
            normalize_qualification(source, data, "https://example.com/index.json")

    def test_rejects_non_integer_or_negative_run_attempts(self):
        source = {"id": "x", "engine": "llamacpp", "channel": "stable"}
        for attempt in ("2", "10", -1, True, None):
            with self.subTest(attempt=attempt):
                data = fixture("llama.json")
                data["builds"][0]["run_attempt"] = attempt
                with self.assertRaisesRegex(ValueError, "run_attempt"):
                    normalize_qualification(
                        source, data, "https://example.com/index.json"
                    )

    def test_rejects_report_path_escape(self):
        data = fixture("llama.json")
        data["builds"][0]["report_url"] = "https://other.example/report.json"
        with self.assertRaisesRegex(ValueError, "report_url"):
            normalize_qualification(
                {"id": "x", "engine": "llamacpp", "channel": "stable"},
                data,
                "https://example.com/index.json",
            )


class PerformanceTests(unittest.TestCase):
    def test_precise_diagnostics_for_required_metrics_identity_and_containers(self):
        source = fixture("performance-source.json")
        for field in (
            "fork_version",
            "run_id",
            "model",
            "scenario",
            "tps_mean",
            "ttft_ms_mean",
        ):
            data = fixture("performance.json")
            del data["by_model_scenario"]["model|context-32k"][0][field]
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_performance(source, data)
            self.assertEqual(
                raised.exception.diagnostic,
                {
                    "source_id": source["id"],
                    "record": "/by_model_scenario/model|context-32k/0",
                    "field": field,
                    "reason": "missing or invalid required value",
                },
            )
        for field, value in (
            ("tps_mean", True),
            ("ttft_ms_mean", float("nan")),
            ("accuracy", 1.5),
            ("accuracy_pass", "yes"),
            ("accuracy_total", -1),
        ):
            data = fixture("performance.json")
            data["by_model_scenario"]["model|context-32k"][0][field] = value
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_performance(source, data)
            self.assertEqual(raised.exception.diagnostic["field"], field)
        data = fixture("performance.json")
        data["history"]["Gemma-4-26B-A4B-it-GGUF"]["context-32k"] = []
        with self.assertRaises(PipelineValidationError) as raised:
            normalize_performance(source, data)
        self.assertEqual(
            raised.exception.diagnostic["record"],
            "/history/Gemma-4-26B-A4B-it-GGUF/context-32k",
        )

    def test_optional_nulls_and_all_run_identity_are_validated(self):
        source = fixture("performance-source.json")
        data = fixture("performance.json")
        latest = data["by_model_scenario"]["model|context-32k"][0]
        latest.update(tps_p95=None, accuracy=None, accuracy_pass=None)
        normalize_performance(source, data)
        for field, value in (
            ("fork_repo", "wrong/repository"),
            ("backend", "wrong"),
            ("run_id", "not-a-number"),
            ("run_url", "https://github.com/lemonade-sdk/lemonade/actions/runs/7"),
        ):
            broken = copy.deepcopy(data)
            broken["by_model_scenario"]["model|context-32k"][0][field] = value
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_performance(source, broken)
            self.assertEqual(raised.exception.diagnostic["field"], field)
        broken = copy.deepcopy(data)
        history = broken["history"]["Gemma-4-26B-A4B-it-GGUF"]["context-32k"][
            "llamacpp-rocm-nightly"
        ][0]
        history["run_url"] = (
            "https://github.com/elsewhere/repo/actions/runs/40290464171"
        )
        source["repository"] = "lemonade-sdk/lemonade"
        with self.assertRaises(PipelineValidationError) as raised:
            normalize_performance(source, broken)
        self.assertEqual(raised.exception.diagnostic["field"], "run_url")
        self.assertTrue(raised.exception.diagnostic["record"].startswith("/history/"))

    def test_rejects_invalid_optional_consumed_values(self):
        source = fixture("performance-source.json")
        for field, value in (
            ("ctx_size", {}),
            ("ctx_size", 0),
            ("input_tokens", "5"),
            ("input_tokens", -1),
            ("quant", {}),
        ):
            data = fixture("performance.json")
            data["by_model_scenario"]["model|context-32k"][0][field] = value
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_performance(source, data)
            self.assertEqual(raised.exception.diagnostic["field"], field)
        for field, value in (
            ("cpu", {}),
            ("gpu", 1),
            ("gpu_full", {}),
            ("os", False),
            ("ram_gb", True),
            ("vram_gb", float("inf")),
        ):
            data = fixture("performance.json")
            data["systems"][0][field] = value
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                normalize_performance(source, data)
            self.assertEqual(raised.exception.diagnostic["field"], field)
            self.assertEqual(raised.exception.diagnostic["record"], "/systems/0")

    def test_producer_gpu_array_accepts_published_shape_and_empty(self):
        data = fixture("performance.json")
        gpu = {
            "integrated": True,
            "name": "AMD Radeon Graphics (gfx1151)",
            "type": "amd",
            "vram_gb": 32.0,
        }
        for value in ([gpu], [], "legacy GPU"):
            data["systems"][0]["gpu_full"] = value
            normalize_performance(fixture("performance-source.json"), data)
        for value in (
            [{"name": []}],
            [{"name": "GPU", "integrated": "yes"}],
            [{"name": "GPU", "vram_gb": -1}],
            [{}],
        ):
            data["systems"][0]["gpu_full"] = value
            with self.subTest(value=value), self.assertRaises(PipelineValidationError):
                normalize_performance(fixture("performance-source.json"), data)

    def test_keeps_build_attribution_unknown_and_accuracy_separate(self):
        source = fixture("performance-source.json")
        rows = normalize_performance(source, fixture("performance.json"))
        latest = next(r for r in rows if r["kind"] == "latest")
        self.assertEqual(latest["engine"], "llamacpp")
        self.assertEqual(latest["channel"], "nightly")
        self.assertEqual(latest["metrics"]["tps_mean"], 36.79)
        self.assertIsNone(latest["qualification_build_id"])
        self.assertIsNone(latest["rocm_version"])
        self.assertIsNone(latest["accuracy_verdict"])
        self.assertTrue(latest["producer_accuracy"]["accuracy_pass"])
        self.assertEqual(latest["system_id"], "system-1")
        self.assertEqual(latest["engine_version"], "b1355")

    def test_history_does_not_inherit_latest_system_or_build(self):
        rows = normalize_performance(
            fixture("performance-source.json"), fixture("performance.json")
        )
        history = next(r for r in rows if r["kind"] == "history")
        self.assertIsNone(history["system_id"])
        self.assertIsNone(history["context_size"])
        self.assertEqual(history["engine_version"], "b1354")
        self.assertEqual(history["metrics"]["tps_mean"], 37.06)

    def test_dangling_and_duplicate_hardware_ids_are_rejected(self):
        for problem in ("dangling", "duplicate"):
            with self.subTest(problem=problem):
                data = fixture("performance.json")
                if problem == "dangling":
                    data["by_model_scenario"]["model|context-32k"][0][
                        "hw_id"
                    ] = "unknown"
                else:
                    data["systems"].append(copy.deepcopy(data["systems"][0]))
                with self.assertRaisesRegex(ValueError, "system"):
                    normalize_performance(fixture("performance-source.json"), data)

    def test_unconfigured_fork_is_not_silently_assigned_to_engine(self):
        data = fixture("performance.json")
        data["by_model_scenario"]["model|context-32k"][0]["fork_id"] = "unknown"
        with self.assertRaisesRegex(ValueError, "unknown fork"):
            normalize_performance(fixture("performance-source.json"), data)


class CollectionTests(unittest.TestCase):
    def config(self):
        return {
            "schema_version": 1,
            "engines": [
                {"id": "llamacpp", "label": "llama.cpp"},
                {"id": "whisper", "label": "Whisper"},
            ],
            "reference_model": None,
            "sources": [
                {
                    "id": "llama",
                    "engine": "llamacpp",
                    "adapter": "qualification-v1",
                    "repository": "a/b",
                    "ref": "qualification-data",
                    "path": "qualification/index.json",
                    "channel": "stable",
                    "stale_after_hours": 72,
                },
                {
                    "id": "whisper",
                    "engine": "whisper",
                    "adapter": "qualification-v1",
                    "availability": "awaiting_data",
                    "channel": "stable",
                },
            ],
        }

    def test_main_fatal_evidence_writes_diagnostic_index_and_summary(self):
        from scripts.collect import main

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "sources.json").write_text(json.dumps(self.config()))
            (root / "evidence.json").write_text(
                json.dumps({"schema_version": 1, "packages": []})
            )
            output = root / "data"
            output.mkdir()
            (output / "index.json").write_text(
                json.dumps(
                    {
                        "collection_status": "complete",
                        "generated_at": "2026-10-01T00:00:00Z",
                    }
                )
            )
            diagnostic = PipelineValidationError(
                "performance", "/history/m/s/f/0", "package", "evidence unavailable"
            )
            with patch(
                "sys.argv",
                [
                    "collect",
                    "--sources",
                    str(root / "sources.json"),
                    "--output-dir",
                    str(output),
                    "--package-evidence",
                    str(root / "evidence.json"),
                ],
            ), patch("scripts.collect.collect", side_effect=diagnostic), patch.dict(
                "os.environ", {"GITHUB_STEP_SUMMARY": str(root / "summary")}
            ):
                self.assertEqual(main(), 1)
            self.assertEqual(
                json.loads((output / "errors.json").read_text()),
                {"errors": [diagnostic.diagnostic]},
            )
            index = json.loads((output / "index.json").read_text())
            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(index["errors"], [diagnostic.diagnostic])
            self.assertEqual(
                index["sync"]["last_successful_at"], "2026-10-01T00:00:00Z"
            )
            self.assertEqual(index["sync"]["status"], "failed")
            self.assertEqual(
                json.loads((output / "sync.json").read_text())["sync"], index["sync"]
            )
            self.assertIn("/history/m/s/f/0", (root / "summary").read_text())

    def test_fetch_failure_diagnostic_contains_url(self):
        def fetch(url):
            raise OSError("offline")

        with tempfile.TemporaryDirectory() as folder:
            output = collect(
                self.config(), Path(folder), fetch, now="2026-10-27T12:00:00Z"
            )
            diagnostic = output["errors"][0]
            self.assertEqual(
                (diagnostic["source_id"], diagnostic["field"]), ("llama", "fetch")
            )
            self.assertIn(
                "https://api.github.com/repos/a/b/commits/", diagnostic["reason"]
            )

    def test_malformed_root_evidence_file_overwrites_stale_complete(self):
        from scripts.collect import main

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "data"
            output.mkdir()
            (output / "index.json").write_text(
                json.dumps(
                    {
                        "collection_status": "complete",
                        "generated_at": "2026-10-01T00:00:00Z",
                    }
                )
            )
            (root / "evidence.json").write_text("[]")
            (root / "sources.json").write_text(json.dumps(self.config()))
            with patch(
                "sys.argv",
                [
                    "collect",
                    "--sources",
                    str(root / "sources.json"),
                    "--output-dir",
                    str(output),
                    "--package-evidence",
                    str(root / "evidence.json"),
                ],
            ):
                self.assertEqual(main(), 1)
            index = json.loads((output / "index.json").read_text())
            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(index["sync"]["status"], "failed")
            self.assertEqual(
                index["sync"]["last_successful_at"], "2026-10-01T00:00:00Z"
            )
            self.assertEqual(
                json.loads((output / "errors.json").read_text())["errors"],
                index["errors"],
            )

    def test_malformed_previous_provenance_rejected(self):
        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else fixture("llama.json")

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "prior/provenance").mkdir(parents=True)
            (root / "prior/provenance/packages.json").write_text("[]")
            with self.assertRaises(PipelineValidationError) as raised:
                collect(
                    self.config(),
                    root / "new",
                    fetch,
                    now="2026-10-27T12:00:00Z",
                    previous_data=root / "prior",
                )
            self.assertEqual(raised.exception.diagnostic["field"], "package_evidence")

    def test_source_failure_publishes_contextual_errors(self):
        def fetch(url):
            if "/commits/" in url:
                return {"sha": "a" * 40}
            data = fixture("llama.json")
            del data["builds"][0]["tag"]
            return data

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = collect(self.config(), root, fetch, now="2026-10-27T12:00:00Z")
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["dataset"]["sync"]["status"], "failed")
            self.assertEqual(output["dataset"]["sync"]["errors"], output["errors"])
            self.assertEqual(output["errors"][0]["record"], "/builds/0")
            self.assertEqual(output["errors"][0]["field"], "tag")
            self.assertEqual(
                json.loads((root / "errors.json").read_text()),
                {"errors": output["errors"]},
            )
            self.assertEqual(
                json.loads((root / "index.json").read_text())["collection_status"],
                "degraded",
            )

    def test_pins_source_snapshot_and_marks_stale_by_observation_time(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if "/commits/" in url:
                return {"sha": "a" * 40}
            return fixture("llama.json")

        with tempfile.TemporaryDirectory() as folder:
            output = collect(
                self.config(), Path(folder), fetch, now="2026-10-30T13:39:10Z"
            )
            self.assertEqual(output["sources"][0]["status"], "stale")
            self.assertEqual(output["sources"][1]["status"], "awaiting_data")
            self.assertEqual(output["collection_status"], "complete")
            self.assertIn("/" + "a" * 40 + "/", calls[1])
            self.assertEqual(len(output["sources"][0]["sha256"]), 64)
            self.assertTrue((Path(folder) / "raw/llama.json").exists())
            self.assertEqual(output["builds"][0]["source_id"], "llama")

    def test_exports_versioned_ui_files_instead_of_combined_mirror(self):
        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else fixture("llama.json")

        with tempfile.TemporaryDirectory() as folder:
            collect(self.config(), Path(folder), fetch, now="2026-10-27T16:00:00Z")
            index = json.loads((Path(folder) / "index.json").read_text())
            self.assertEqual(index["schema_version"], 2)
            self.assertEqual(index["versions"][0]["rocm_version"], "10.0")
            overview = json.loads(
                (Path(folder) / index["versions"][0]["overview"]).read_text()
            )
            self.assertEqual(overview["rocm_version"], "10.0")
            self.assertFalse((Path(folder) / "output.json").exists())

    def test_collection_carries_prior_builds_forward_when_source_prunes_them(self):
        data = fixture("llama.json")

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            previous = Path(folder) / "previous"
            current = Path(folder) / "current"
            collect(self.config(), previous, fetch, now="2026-10-27T16:00:00Z")
            data["builds"][0]["build_id"] = "new-build"
            collect(
                self.config(),
                current,
                fetch,
                now="2026-10-27T17:00:00Z",
                previous_data=previous,
            )
            index = json.loads((current / "index.json").read_text())
            self.assertEqual(index["versions"][0]["build_count"], 2)

    def test_cli_marks_output_degraded_when_previous_history_is_invalid(self):
        config = self.config()
        config["sources"] = [config["sources"][1]]
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            sources = base / "sources.json"
            sources.write_text(json.dumps(config))
            output = base / "data"
            output.mkdir()
            (output / "index.json").write_text(
                '{"collection_status":"complete","versions":[]}'
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve().parents[1] / "scripts/collect.py"),
                    "--sources",
                    str(sources),
                    "--output-dir",
                    str(output),
                    "--previous-data",
                    str(base / "missing"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 1)
            index = json.loads((output / "index.json").read_text())
            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(index["versions"], [])

    def test_failed_source_does_not_become_healthy_or_reuse_previous_output(self):
        def fetch(url):
            raise OSError("offline")

        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "index.json").write_text('{"old": true}')
            output = collect(
                self.config(), Path(folder), fetch, now="2026-10-27T16:00:00Z"
            )
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["sources"][0]["status"], "error")
            self.assertEqual(output["builds"], [])
            self.assertNotIn(
                "old", json.loads((Path(folder) / "index.json").read_text())
            )

    def test_duplicate_ids_and_path_traversal_fail_before_fetch(self):
        for mutate in ("duplicate", "path"):
            config = self.config()
            if mutate == "duplicate":
                config["sources"].append(copy.deepcopy(config["sources"][0]))
            else:
                config["sources"][0]["id"] = "../escape"
            with tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError):
                    collect(
                        config, Path(folder), lambda url: self.fail("must not fetch")
                    )

    def test_invalid_system_metadata_does_not_leak_measurements(self):
        config = self.config()
        source = fixture("performance-source.json")
        source.update(
            repository="a/b",
            ref="benchmark-data",
            path="leaderboard.json",
            channel="from-fork",
            stale_after_hours=72,
        )
        config["sources"] = [source]
        data = fixture("performance.json")
        data["systems"] = ["invalid-system"]

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            output = collect(config, Path(folder), fetch)
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["measurements"], [])
            self.assertEqual(output["sources"][0]["record_count"], 0)

    def test_future_observation_fails_source_instead_of_marking_fresh(self):
        data = fixture("llama.json")
        data["builds"][0]["generated_at"] = "2036-10-27T12:39:10Z"

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            output = collect(
                self.config(), Path(folder), fetch, now="2026-10-27T16:00:00Z"
            )
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["sources"][0]["status"], "error")
            self.assertEqual(output["builds"], [])

    def test_empty_feed_is_not_reported_fresh(self):
        data = fixture("llama.json")
        data["builds"] = []

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            output = collect(self.config(), Path(folder), fetch)
            self.assertEqual(output["sources"][0]["status"], "empty")
            self.assertIsNone(output["sources"][0]["latest_observation_at"])

    def test_failed_normalization_does_not_leak_partial_records(self):
        data = fixture("llama.json")
        data["builds"].append({"build_id": "bad"})

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            output = collect(self.config(), Path(folder), fetch)
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["builds"], [])


if __name__ == "__main__":
    unittest.main()


class StableIntegrationTests(unittest.TestCase):
    def test_real_cli_package_access_failure_publishes_sync_diagnostics(self):
        from scripts.collect import main
        from scripts.sync import publish_sync
        from tests.test_attribution import measurement

        source = fixture("performance-source.json")
        source.update(
            id="performance",
            repository="lemonade-sdk/lemonade",
            ref="benchmark-data",
            path="leaderboard.json",
            stale_after_hours=72,
            channel="from-fork",
        )
        source["forks"]["stable"] = {
            "engine": "llamacpp",
            "channel": "stable",
            "backend": "rocm",
            "repository": "lemonade-sdk/llama.cpp",
        }
        config = CollectionTests().config()
        config["sources"] = [source]
        data = {
            "systems": [],
            "history": {},
            "by_model_scenario": {
                "m|s": [
                    {
                        "model": "m",
                        "scenario": "s",
                        "fork_id": "stable",
                        "fork_version": "b123",
                        "timestamp": "2026-10-27T10:05:00Z",
                        "run_id": "42",
                        "run_url": measurement()["run_url"],
                        "tps_mean": 12,
                        "ttft_ms_mean": 100,
                    }
                ]
            },
        }

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        original_collect = collect

        def injected(config, destination, **kwargs):
            return original_collect(config, destination, fetch=fetch, **kwargs)

        def denied(*args, **kwargs):
            raise PermissionError("logs unavailable")

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = root / "data"
            publish_sync(output, "2026-10-01T00:00:00Z", "success", None, [])
            (root / "sources.json").write_text(json.dumps(config))
            (root / "evidence.json").write_text(
                json.dumps({"schema_version": 1, "packages": []})
            )
            with patch(
                "sys.argv",
                [
                    "collect",
                    "--sources",
                    str(root / "sources.json"),
                    "--output-dir",
                    str(output),
                    "--package-evidence",
                    str(root / "evidence.json"),
                ],
            ), patch("scripts.collect.collect", side_effect=injected), patch(
                "scripts.collect.resolve_package", side_effect=denied
            ):
                self.assertEqual(main(), 1)
            index = json.loads((output / "index.json").read_text())
            error = json.loads((output / "errors.json").read_text())["errors"][0]
            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(error["field"], "package_evidence")
            self.assertEqual(error["record"], "/by_model_scenario/m|s/0")
            self.assertEqual(index["sync"]["status"], "failed")
            self.assertEqual(
                index["sync"]["last_successful_at"], "2026-10-01T00:00:00Z"
            )
            self.assertEqual(
                json.loads((output / "sync.json").read_text())["sync"], index["sync"]
            )

    def test_seed_evidence_publishes_version_performance_and_provenance(self):
        from tests.test_attribution import evidence, measurement

        config = CollectionTests().config()
        source = fixture("performance-source.json")
        source.update(
            id="performance",
            repository="lemonade-sdk/lemonade",
            ref="benchmark-data",
            path="leaderboard.json",
            stale_after_hours=72,
            channel="from-fork",
        )
        source["forks"]["llamacpp-rocm-stable"] = {
            "engine": "llamacpp",
            "channel": "stable",
            "backend": "rocm",
            "repository": "lemonade-sdk/llama.cpp",
        }
        config["sources"] = [source]
        data = {
            "systems": [],
            "by_model_scenario": {
                "model|scenario": [
                    {
                        "model": "model",
                        "scenario": "scenario",
                        "fork_id": "llamacpp-rocm-stable",
                        "fork_version": "b123",
                        "timestamp": "2026-10-27T10:05:00Z",
                        "run_id": "42",
                        "run_url": measurement()["run_url"],
                        "tps_mean": 12,
                        "ttft_ms_mean": 100,
                        "accuracy": 0.8,
                        "accuracy_pass": False,
                    }
                ]
            },
            "history": {},
        }

        def fetch(url):
            return {"sha": "a" * 40} if "/commits/" in url else data

        with tempfile.TemporaryDirectory() as folder:
            output = collect(
                config,
                Path(folder),
                fetch,
                now="2026-10-27T12:00:00Z",
                package_evidence=[evidence()],
            )
            self.assertEqual(output["dataset"]["default_version"], "10.1")
            self.assertEqual(
                output["dataset"]["stable_performance"],
                {
                    "assigned_count": 1,
                    "awaiting_evidence_count": 0,
                },
            )
            perf = json.loads((Path(folder) / "rocm/10.1/performance.json").read_text())
            self.assertEqual(perf["measurements"][0]["rocm_version"], "10.1")
            self.assertEqual(
                perf["measurements"][0]["producer_accuracy"]["accuracy"], 0.8
            )
            self.assertIn("/" + "a" * 40 + "/", perf["measurements"][0]["source_url"])
            saved = json.loads((Path(folder) / "provenance/packages.json").read_text())
            self.assertEqual(saved["packages"], [evidence()])

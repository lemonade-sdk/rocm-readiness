import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.collect import collect, normalize_qualification, normalize_performance

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class QualificationTests(unittest.TestCase):
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

    def test_failed_source_does_not_become_healthy_or_reuse_previous_output(self):
        def fetch(url):
            raise OSError("offline")

        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "output.json").write_text('{"old": true}')
            output = collect(
                self.config(), Path(folder), fetch, now="2026-10-27T16:00:00Z"
            )
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["sources"][0]["status"], "error")
            self.assertEqual(output["builds"], [])
            self.assertNotIn(
                "old", json.loads((Path(folder) / "output.json").read_text())
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

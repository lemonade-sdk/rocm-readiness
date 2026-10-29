"""Independent expectations for small, pinned, real producer excerpts.

Raw values and their original JSON pointers live beside a checksum manifest.
Synthetic corruptions are made in tests, never stored as producer evidence.
"""

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.attribution import attribute_stable
from scripts.collect import normalize_performance, normalize_qualification
from scripts.dataset import write_dataset
from scripts.validation import PipelineValidationError

FIXTURES = Path(__file__).parent / "fixtures" / "pinned"
MODEL = "Gemma-4-26B-A4B-it-GGUF"
SCENARIO = "context-32k"
FORK = "llamacpp-rocm-stable"
SYSTEM = "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S|0.5|linux"
QUALIFICATION_SOURCE = {
    "id": "llamacpp-stable-qualification",
    "engine": "llamacpp",
    "channel": "stable",
}
PERFORMANCE_SOURCE = {
    "id": "lemonade-performance",
    "repository": "lemonade-sdk/lemonade",
    "include_forks": [FORK],
    "forks": {
        FORK: {
            "engine": "llamacpp",
            "channel": "stable",
            "backend": "rocm",
            "repository": "lemonade-sdk/llama.cpp",
        }
    },
}


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def canonical(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()


def inputs():
    manifest = fixture("manifest.json")
    qualification = fixture("qualification-fragments.json")
    fragments = fixture("performance-fragments.json")
    performance = {
        "by_model_scenario": {f"{MODEL}|{SCENARIO}": fragments[0]["value"]},
        "history": {MODEL: {SCENARIO: {FORK: fragments[1]["value"]}}},
        "systems": fragments[2]["value"],
    }
    return manifest, qualification, performance


def normalized():
    manifest, qualification, performance = inputs()
    qurl = manifest["sources"]["qualification"]["url"]
    purl = manifest["sources"]["performance"]["url"]
    builds = normalize_qualification(
        QUALIFICATION_SOURCE,
        {"schema_version": 1, "builds": [row["value"] for row in qualification]},
        qurl,
    )
    # The fixture is a subset. Restore its original producer array positions
    # after checking the adapter's local-pointer behavior separately below.
    for row, fragment in zip(builds, qualification):
        row["source_pointer"] = fragment["pointer"]
    rows = normalize_performance(PERFORMANCE_SOURCE, performance)
    # Only this run's package evidence was captured. Other real history remains
    # in the fixture to prove that missing hardware/context is not inferred.
    selected = [row for row in rows if str(row["run_id"]) == "40537509555"]
    for row in selected:
        row["source_url"] = purl
    output = {
        "schema_version": 1,
        "generated_at": "2026-10-29T20:00:00Z",
        "collection_status": "complete",
        "reference_model": None,
        "engines": [
            {"id": "llamacpp", "label": "llama.cpp", "platforms": ["linux", "windows"]}
        ],
        "sources": [
            {
                "id": "llamacpp-stable-qualification",
                "engine": "llamacpp",
                "channel": "stable",
                "adapter": "qualification-v1",
                "status": "fresh",
                "record_count": 5,
                "url": qurl,
            },
            {
                "id": "lemonade-performance",
                "engine": "llamacpp",
                "channel": "from-fork",
                "adapter": "lemonade-leaderboard-v1",
                "status": "fresh",
                "record_count": len(selected),
                "url": purl,
            },
        ],
        "builds": builds,
        "measurements": selected,
        "systems": [
            {
                **system,
                "source_id": "lemonade-performance",
                "source_pointer": f"/systems/{index}",
            }
            for index, system in enumerate(performance["systems"])
        ],
    }
    attribute_stable(output, [fixture("package-evidence.json")["evidence"]])
    return output


class PinnedMappingTests(unittest.TestCase):
    def test_exact_fragments_and_download_evidence_have_recorded_checksums(self):
        manifest = fixture("manifest.json")
        for name in ("qualification", "performance"):
            source = manifest["sources"][name]
            self.assertRegex(source["commit"], r"^[a-f0-9]{40}$")
            self.assertIn("/" + source["commit"] + "/", source["url"])
            fragments = fixture(name + "-fragments.json")
            self.assertEqual(len(source["fragments"]), len(fragments))
            for recorded, fragment in zip(source["fragments"], fragments):
                self.assertEqual(recorded["pointer"], fragment["pointer"])
                self.assertEqual(
                    recorded["sha256"],
                    hashlib.sha256(canonical(fragment["value"])).hexdigest(),
                )
        package = fixture("package-evidence.json")
        self.assertEqual(
            package["excerpt_sha256"],
            hashlib.sha256(package["log_excerpt"].encode()).hexdigest(),
        )
        self.assertIn(
            "Downloading " + package["evidence"]["package_url"], package["log_excerpt"]
        )

    def test_qualification_fields_and_os_aliases_match_hand_checked_source(self):
        manifest, fragments, _ = inputs()
        rows = normalize_qualification(
            QUALIFICATION_SOURCE,
            {"schema_version": 1, "builds": [row["value"] for row in fragments]},
            manifest["sources"]["qualification"]["url"],
        )
        self.assertEqual(
            [(row["build_id"], row["tag"], row["os"]) for row in rows],
            [
                ("40870439417-ubuntu-rocm-10.1", "b11997", "linux"),
                ("40870439417-win-rocm-10.1", "b11997", "windows"),
                ("40792119563-ubuntu-rocm-10.1", "b11972", "linux"),
                ("40792119563-win-rocm-10.1", "b11972", "windows"),
                ("40501231559-ubuntu-rocm-10.1", "b11932", "linux"),
            ],
        )
        self.assertEqual(rows[0]["source_pointer"], "/builds/0")
        self.assertEqual(
            rows[0]["upstream_sha"], "0ac1a7fd35c127a18c0cbc6c57d12e256a6a385b"
        )
        self.assertEqual(rows[0]["run_id"], "40870439417")
        self.assertEqual(rows[0]["event"], "schedule")
        self.assertEqual(rows[0]["results"]["T0.9"], "skip")
        self.assertTrue(rows[1]["qualified"])
        self.assertEqual(rows[1]["overall"], "warn")
        self.assertEqual(
            rows[1]["tests"],
            {
                "passed": 13,
                "failed": 0,
                "warned": 1,
                "skipped": 3,
                "missing": 0,
                "total": 17,
            },
        )
        self.assertEqual(
            rows[0]["report_url"],
            "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/55cc3a880c1635ab08c7bd115538886fe60ae6be/qualification/reports/40870439417-ubuntu-rocm-10.1.json",
        )

    def test_benchmark_fork_filter_and_missing_history_metadata_are_explicit(self):
        _, _, performance = inputs()
        rows = normalize_performance(PERFORMANCE_SOURCE, performance)
        self.assertEqual(len(rows), 6)  # One stable latest + five stable history.
        self.assertEqual({row["fork_id"] for row in rows}, {FORK})
        latest = rows[0]
        self.assertEqual(
            latest["source_pointer"], f"/by_model_scenario/{MODEL}|{SCENARIO}/3"
        )
        self.assertEqual(latest["engine_version"], "b11932")
        self.assertEqual(latest["run_id"], "40537509555")
        self.assertEqual(latest["measured_at"], "2026-10-27T19:12:45Z")
        self.assertEqual(latest["system_id"], SYSTEM)
        self.assertEqual(latest["context_size"], 32768)
        self.assertEqual(latest["input_tokens"], 24035)
        self.assertEqual(latest["metrics"]["tg_tps"], 36.65)
        self.assertEqual(latest["metrics"]["ttft_ms_mean"], 21471.51)
        self.assertIsNone(latest["rocm_version"])
        self.assertIsNone(latest["qualification_build_id"])
        # Even the matching historical row lacks these fields in producer data.
        self.assertEqual(rows[-1]["engine_version"], "b11932")
        self.assertIsNone(rows[-1]["system_id"])
        self.assertIsNone(rows[-1]["context_size"])

    def test_package_evidence_join_dedup_counts_and_monthly_latest_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = normalized()
            # ROCm comes from a checked package, independently of benchmark run ID.
            self.assertEqual(
                {row["rocm_version"] for row in output["measurements"]}, {"10.1"}
            )
            self.assertEqual(
                {row["package_os"] for row in output["measurements"]}, {"linux"}
            )
            index = write_dataset(output, root)
            overview = json.loads((root / "rocm/10.1/overview.json").read_text())
            history = json.loads((root / "rocm/10.1/history/2026-10.json").read_text())
            performance = json.loads((root / "rocm/10.1/performance.json").read_text())
            self.assertEqual(
                index["versions"],
                [
                    {
                        "rocm_version": "10.1",
                        "overview": "rocm/10.1/overview.json",
                        "build_count": 5,
                    }
                ],
            )
            self.assertEqual(
                overview["history"],
                [
                    {
                        "month": "2026-10",
                        "path": "rocm/10.1/history/2026-10.json",
                        "build_count": 5,
                    }
                ],
            )
            self.assertEqual(history["month"], "2026-10")
            self.assertEqual(len(history["builds"]), 5)
            self.assertEqual(overview["engines"][0]["build_count"], 5)
            self.assertEqual(
                [row["build_id"] for row in overview["engines"][0]["latest_builds"]],
                ["40870439417-ubuntu-rocm-10.1", "40870439417-win-rocm-10.1"],
            )
            self.assertEqual(index["stable_performance"]["assigned_count"], 1)
            self.assertEqual(len(performance["measurements"]), 1)
            measured = performance["measurements"][0]
            self.assertEqual(measured["kind"], "latest")
            self.assertEqual(
                measured["qualification_build_id"], "40501231559-ubuntu-rocm-10.1"
            )
            self.assertNotEqual(measured["qualification_build_id"], measured["run_id"])
            self.assertEqual(measured["attribution"]["status"], "matched")
            self.assertEqual(measured["system_id"], SYSTEM)
            self.assertEqual(measured["context_size"], 32768)
            self.assertEqual(measured["metrics"]["tg_tps"], 36.65)
            self.assertEqual(performance["systems"][0]["ram_gb"], 124.95)
            # Provenance points at the original full producer array, not subset index.
            associated = next(
                row for row in history["builds"] if row["tag"] == "b11932"
            )
            self.assertEqual(associated["source_pointer"], "/builds/25")

    def test_retained_records_merge_by_identity_then_obey_source_scope(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = normalized()
            previous["builds"] = previous["builds"][2:]
            write_dataset(previous, root / "old")
            current = normalized()
            current["builds"] = current["builds"][:2]
            current["measurements"] = []
            current["systems"] = []
            result = write_dataset(current, root / "new", root / "old")
            self.assertEqual(result["versions"][0]["build_count"], 5)
            self.assertEqual(result["stable_performance"]["assigned_count"], 1)
            # An empty approved scope must not retain records from either feed.
            current["builds"] = []
            scoped = write_dataset(
                current, root / "scoped", root / "new", source_configs={}
            )
            self.assertEqual(scoped["versions"], [])
            self.assertEqual(scoped["stable_performance"]["assigned_count"], 0)

    def test_synthetic_wrong_backend_and_package_identity_are_rejected(self):
        _, _, performance = inputs()
        performance["by_model_scenario"][f"{MODEL}|{SCENARIO}"][3]["backend"] = "vulkan"
        with self.assertRaisesRegex(
            PipelineValidationError, "backend.*producer identity"
        ):
            normalize_performance(PERFORMANCE_SOURCE, performance)
        output = normalized()
        evidence = copy.deepcopy(fixture("package-evidence.json")["evidence"])
        evidence["engine_version"] = "b11997"
        with self.assertRaisesRegex(
            PipelineValidationError, "package identity mismatch"
        ):
            attribute_stable(output, [evidence])


if __name__ == "__main__":
    unittest.main()

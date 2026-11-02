"""Detailed producer execution normalization and inventory selection."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.executions import collect_executions

ROOT = Path(__file__).parent / "fixtures" / "executions"
COMMIT = "06a147bc08581b64c099e859de9463206f2fc687"
SOURCE = {
    "id": "lemonade-performance",
    "repository": "lemonade-sdk/lemonade",
    "include_forks": ["llamacpp-rocm-stable"],
    "forks": {
        "llamacpp-rocm-stable": {
            "engine": "llamacpp",
            "channel": "stable",
            "backend": "rocm",
            "repository": "lemonade-sdk/llama.cpp",
        }
    },
}
TREE = f"https://api.github.com/repos/{SOURCE['repository']}/git/trees/{COMMIT}?recursive=1"
BASE = f"https://raw.githubusercontent.com/{SOURCE['repository']}/{COMMIT}/"


def fixture(name):
    return json.loads((ROOT / f"{name}.json").read_text())


def inventory(documents):
    paths = {}
    for i, document in enumerate(documents):
        model = document["models"][0]["model"]
        path = f"results/llamacpp-rocm-stable/{model}/run-202610{i + 1:02}T190934Z.json"
        paths[path] = copy.deepcopy(document)
    tree = {
        "truncated": False,
        "tree": [
            {"path": path, "type": "blob", "sha": f"{i + 1:040x}"}
            for i, path in enumerate(paths)
        ],
    }
    reads = []

    def fetch(url):
        reads.append(url)
        if url == TREE:
            return copy.deepcopy(tree)
        if url.startswith(BASE):
            return copy.deepcopy(paths[url[len(BASE) :]])
        raise AssertionError(url)

    return tree, paths, reads, fetch


class ExecutionTests(unittest.TestCase):
    def test_authentic_outcomes_include_metricless_failures_and_partial_attempts(self):
        _, _, _, fetch = inventory(
            [fixture("passed"), fixture("failed"), fixture("partial")]
        )
        result = collect_executions(SOURCE, COMMIT, fetch)
        outcomes = {(row["model"], row["scenario"]): row for row in result["attempts"]}
        passed = outcomes[("Gemma-4-31B-it-GGUF", "context-32k")]
        failed = outcomes[("gpt-oss-20b-mxfp4-GGUF", "context-32k")]
        partial = outcomes[("MiniCPM5-1B-GGUF", "context-4k")]
        self.assertEqual(passed["execution_status"], "passed")
        self.assertEqual(failed["execution_status"], "failed")
        self.assertEqual(failed["failed_runs"], 4)
        self.assertEqual(failed["measurement_runs"], 3)
        self.assertEqual(partial["execution_status"], "partial")
        self.assertIsNone(failed["quant"])
        self.assertEqual(
            passed["checkpoints"]["main"], "unsloth/gemma-4-31B-it-GGUF:Q4_K_M"
        )
        self.assertIsNone(failed["rocm_version"])
        self.assertEqual(failed["engine_version"], "b11932")
        self.assertIn("/models/0/results/1/scenarios/0", failed["source_pointer"])
        self.assertIn(failed["source_url"], result["snapshots"])
        self.assertEqual(result["inventory"]["file_count"], 3)

    def test_latest_failed_attempt_replaces_success_even_with_zero_achieved_tokens(
        self,
    ):
        before = fixture("passed")
        after = copy.deepcopy(before)
        after["models"][0]["timestamp"] = "2026-10-29T20:00:00Z"
        after["fork_version"] = "b11997"
        for backend in after["models"][0]["results"]:
            for scenario in backend["scenarios"]:
                scenario.clear()
                scenario.update(
                    name=f"context-{backend['ctx_size'] // 1024}k",
                    failed_runs=4,
                    all_runs_failed=True,
                    input_tokens=0,
                    output_tokens=0,
                )
        _, _, _, fetch = inventory([before, after])
        rows = collect_executions(SOURCE, COMMIT, fetch)["attempts"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row["execution_status"] == "failed" for row in rows))
        self.assertTrue(all(row["engine_version"] == "b11997" for row in rows))

    def test_missing_execution_fields_do_not_inherit_an_older_pass(self):
        before = fixture("passed")
        after = copy.deepcopy(before)
        after["models"][0]["timestamp"] = "2026-10-29T20:00:00Z"
        for backend in after["models"][0]["results"]:
            for scenario in backend["scenarios"]:
                scenario.pop("failed_runs")
        _, _, _, fetch = inventory([before, after])
        self.assertEqual(
            {
                row["execution_status"]
                for row in collect_executions(SOURCE, COMMIT, fetch)["attempts"]
            },
            {"unknown"},
        )

    def test_zero_failures_without_successful_serializer_shape_is_unknown(self):
        document = fixture("passed")
        for backend in document["models"][0]["results"]:
            for scenario in backend["scenarios"]:
                for key in ("tps", "duration_ms", "ttft_ms"):
                    scenario.pop(key)
        _, _, _, fetch = inventory([document])
        self.assertEqual(
            {
                row["execution_status"]
                for row in collect_executions(SOURCE, COMMIT, fetch)["attempts"]
            },
            {"unknown"},
        )

    def test_partial_failures_require_successful_serializer_shape(self):
        document = fixture("partial")
        for backend in document["models"][0]["results"]:
            for scenario in backend["scenarios"]:
                scenario["duration_ms"] = {"mean": None}
        _, _, _, fetch = inventory([document])
        self.assertEqual(
            {
                row["execution_status"]
                for row in collect_executions(SOURCE, COMMIT, fetch)["attempts"]
            },
            {"unknown"},
        )

    def test_all_failed_flag_cannot_coexist_with_successful_statistics(self):
        document = fixture("failed")
        document["models"][0]["results"][0]["scenarios"][0]["tps"] = {"mean": 1.5}
        _, _, _, fetch = inventory([document])
        with self.assertRaisesRegex(ValueError, "contradictory execution"):
            collect_executions(SOURCE, COMMIT, fetch)

    def test_candidates_preserve_every_attempt_until_rocm_attribution(self):
        before = fixture("passed")
        before["rocm_version"] = "10.0"
        after = copy.deepcopy(before)
        after["rocm_version"] = "10.1"
        after["models"][0]["timestamp"] = "2026-10-29T20:00:00Z"
        _, _, _, fetch = inventory([before, after])
        result = collect_executions(SOURCE, COMMIT, fetch)
        self.assertEqual(len(result["attempts"]), 2)
        self.assertEqual(len(result["candidates"]), 4)
        self.assertEqual(len(result["snapshots"]), 2)

    def test_enabled_source_with_empty_inventory_fails_closed(self):
        _, _, _, fetch = inventory([])
        with self.assertRaisesRegex(ValueError, "empty execution inventory"):
            collect_executions(SOURCE, COMMIT, fetch)

    def test_systems_checkpoints_and_workloads_are_not_merged(self):
        a = fixture("passed")
        b = copy.deepcopy(a)
        b["hardware"]["gpu"][0]["name"] = "Different measured GPU"
        c = copy.deepcopy(a)
        c["models"][0]["checkpoints"]["main"] = "different/checkpoint:Q8_0"
        _, _, _, fetch = inventory([a, b, c])
        rows = collect_executions(SOURCE, COMMIT, fetch)["attempts"]
        self.assertEqual(len(rows), 6)
        self.assertEqual(len({row["system_id"] for row in rows}), 2)

    def test_backend_inventory_is_not_physical_system_or_package_authority(self):
        a = fixture("passed")
        b = copy.deepcopy(a)
        b["hardware"]["backends"]["llamacpp/rocm"] = "b0"
        b["models"][0]["timestamp"] = "2026-10-29T20:00:00Z"
        _, _, _, fetch = inventory([a, b])
        rows = collect_executions(SOURCE, COMMIT, fetch)["attempts"]
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["engine_version"] for row in rows}, {"b11932"})

    def test_conflicting_equal_time_attempts_fail_closed(self):
        a = fixture("passed")
        b = copy.deepcopy(a)
        b["models"][0]["results"][0]["scenarios"][0]["failed_runs"] = 1
        _, _, _, fetch = inventory([a, b])
        with self.assertRaisesRegex(ValueError, "ambiguous latest"):
            collect_executions(SOURCE, COMMIT, fetch)

    def test_truncated_inventory_and_fetch_failures_are_not_silenced(self):
        tree, _, _, fetch = inventory([fixture("passed")])
        tree["truncated"] = True
        with self.assertRaisesRegex(ValueError, "truncated"):
            collect_executions(SOURCE, COMMIT, fetch)

        def broken(url):
            if url == TREE:
                tree["truncated"] = False
                return tree
            raise OSError("producer inaccessible")

        with self.assertRaisesRegex(OSError, "producer inaccessible"):
            collect_executions(SOURCE, COMMIT, broken)

    def test_immutable_cache_reuses_source_blobs_and_keeps_selected_snapshots(self):
        _, _, reads, fetch = inventory([fixture("passed")])
        with tempfile.TemporaryDirectory() as directory:
            first = collect_executions(SOURCE, COMMIT, fetch, cache_dir=Path(directory))
            reads.clear()
            second = collect_executions(
                SOURCE, COMMIT, fetch, cache_dir=Path(directory)
            )
        self.assertEqual(first, second)
        self.assertEqual(reads, [TREE])


if __name__ == "__main__":
    unittest.main()

import json
from pathlib import Path
import tempfile
import unittest

from scripts.dataset import write_dataset

SOURCE_A = (
    "https://raw.githubusercontent.com/example/source/"
    + "a" * 40
    + "/qualification.json"
)
SOURCE_B = (
    "https://raw.githubusercontent.com/example/source/"
    + "b" * 40
    + "/qualification.json"
)
SOURCE_C = (
    "https://raw.githubusercontent.com/example/source/"
    + "c" * 40
    + "/qualification.json"
)


def build(
    build_id="llama-1",
    rocm_version="7.14",
    generated_at="2026-10-01T10:00:00Z",
    **changes,
):
    row = {
        "source_id": "llama-source",
        "build_id": build_id,
        "engine": "llamacpp",
        "tag": "b123",
        "rocm_version": rocm_version,
        "channel": "stable",
        "os": "linux",
        "gfx_target": "gfx1151",
        "hardware_validated": True,
        "gfx": {"requested": 1, "present": 1, "missing": []},
        "qualified": True,
        "version_qualified": True,
        "overall": "pass",
        "generated_at": generated_at,
        "run_attempt": 1,
        "tests": {"passed": 5, "failed": 0, "total": 5},
        "blocked_by": [],
        "blocking_tests": [],
        "report_url": "https://example.test/report.json",
        "run_url": "https://example.test/run",
        "source_pointer": "/builds/0",
    }
    row.update(changes)
    return row


def normalized(builds=None, measurements=None, systems=None, status="complete"):
    return {
        "schema_version": 1,
        "generated_at": "2026-10-02T12:00:00Z",
        "collection_status": status,
        "reference_model": {"id": "reference-model"},
        "engines": [
            {"id": "llamacpp", "label": "llama.cpp", "platforms": ["linux"]},
            {"id": "vllm", "label": "vLLM", "platforms": ["linux"]},
        ],
        "sources": [
            {
                "id": "llama-source",
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": 1,
                "url": SOURCE_A,
            }
        ],
        "builds": builds or [],
        "measurements": measurements or [],
        "systems": systems or [],
    }


class DatasetTests(unittest.TestCase):
    def test_writes_index_overview_and_history_for_a_version(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            result = write_dataset(normalized([build()]), destination)

            self.assertEqual(result["schema_version"], 2)
            self.assertEqual(result["generated_at"], "2026-10-02T12:00:00Z")
            self.assertEqual(result["collection_status"], "complete")
            self.assertEqual(result["engines"], normalized()["engines"])
            self.assertEqual(result["reference_model"], {"id": "reference-model"})
            self.assertEqual(result["default_version"], "7.14")
            self.assertEqual(
                result["versions"],
                [
                    {
                        "rocm_version": "7.14",
                        "overview": "rocm/7.14/overview.json",
                        "build_count": 1,
                    }
                ],
            )
            self.assertEqual(result["sources"], normalized()["sources"])
            self.assertEqual(
                result["unassigned_performance"],
                {"count": 0, "path": "performance/unassigned.json"},
            )
            self.assertEqual(
                result, json.loads((destination / "index.json").read_text())
            )

            self.assertEqual(
                json.loads((destination / "performance/unassigned.json").read_text()),
                {"schema_version": 2, "measurements": [], "systems": []},
            )

            overview = json.loads((destination / "rocm/7.14/overview.json").read_text())
            self.assertEqual(overview["schema_version"], 2)
            self.assertEqual(overview["generated_at"], "2026-10-02T12:00:00Z")
            self.assertEqual(overview["rocm_version"], "7.14")
            self.assertEqual(
                [(card["id"], card["build_count"]) for card in overview["engines"]],
                [("llamacpp", 1), ("vllm", 0)],
            )
            self.assertEqual(overview["history"][0]["month"], "2026-10")
            history = json.loads(
                (destination / overview["history"][0]["path"]).read_text()
            )
            self.assertEqual(history["builds"][0]["build_id"], "llama-1")
            self.assertEqual(
                history["builds"][0]["source_url"],
                SOURCE_A,
            )

    def test_rejects_invalid_current_build_contract(self):
        cases = {
            "qualified": {"qualified": "true"},
            "version_qualified": {"version_qualified": 1},
            "overall": {"overall": "unknown"},
            "run_attempt_string": {"run_attempt": "10"},
            "run_attempt_boolean": {"run_attempt": True},
            "run_attempt_negative": {"run_attempt": -1},
            "source_pointer": {"source_pointer": "builds/0"},
            "report_url": {"report_url": "http://example.test/report.json"},
            "run_url": {"run_url": "https:///missing-host"},
            "test_counts": {"tests": {"passed": -1, "total": 5}},
            "blocked_by": {"blocked_by": ["tier0=fail", 1]},
            "blocking_tests": {"blocking_tests": ["T0.1", 1]},
            "hardware_validated": {"hardware_validated": "yes"},
        }
        for name, changes in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                with self.assertRaises(ValueError):
                    write_dataset(normalized([build(**changes)]), Path(folder))
        malformed_source = normalized([build()])
        malformed_source["sources"][0][
            "url"
        ] = "https://raw.githubusercontent.com/example/source/main/qualification.json"
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(ValueError):
            write_dataset(malformed_source, Path(folder))

    def test_rejects_malformed_prior_build_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous_data = root / "previous"
            write_dataset(normalized([build()]), previous_data)
            chunk_path = previous_data / "rocm/7.14/history/2026-10.json"
            chunk = json.loads(chunk_path.read_text())
            chunk["builds"][0].update(
                qualified="true",
                source_url=(
                    "https://raw.githubusercontent.com/example/source/main/"
                    "qualification.json"
                ),
            )
            chunk_path.write_text(json.dumps(chunk))

            with self.assertRaises(ValueError):
                write_dataset(
                    normalized([build("current")]), root / "current", previous_data
                )

    def test_latest_tie_uses_numeric_run_attempt(self):
        rows = [
            build("attempt-2", generated_at="2026-10-10T10:00:00Z", run_attempt=2),
            build("attempt-10", generated_at="2026-10-10T10:00:00Z", run_attempt=10),
        ]
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            write_dataset(normalized(rows), destination)
            overview = json.loads((destination / "rocm/7.14/overview.json").read_text())
            llama = next(
                card for card in overview["engines"] if card["id"] == "llamacpp"
            )
            self.assertEqual(llama["latest_builds"][0]["build_id"], "attempt-10")

    def test_versions_latest_cards_projection_and_unassigned_performance(self):
        rows = [
            build("7-9", rocm_version="7.9", generated_at="2026-08-01T10:00:00Z"),
            build(
                "stable-first",
                generated_at="2026-10-10T10:00:00Z",
                run_attempt=1,
            ),
            build(
                "stable-rerun",
                generated_at="2026-10-10T10:00:00Z",
                run_attempt=2,
                qualified=False,
                version_qualified=False,
                overall="fail",
                tests={"passed": 2, "failed": 3, "total": 5},
                blocked_by=["tier0=fail"],
                blocking_tests=None,
                summary={"blocking_tests": ["T0.1"]},
                arbitrary_blob={"keep": "out"},
                results={"T0.1": "fail"},
            ),
            build(
                "stable-windows",
                generated_at="2026-10-09T10:00:00Z",
                os="windows",
            ),
            build(
                "nightly-linux",
                generated_at="2026-10-08T10:00:00Z",
                channel="nightly",
            ),
            build("september", generated_at="2026-09-30T10:00:00Z"),
            build(
                "vllm-7-14-0",
                rocm_version="7.14.0",
                source_id="vllm-source",
                engine="vllm",
            ),
            build("7-15", rocm_version="7.15"),
        ]
        measurement = {
            "source_id": "performance-source",
            "source_pointer": "/by_model/0",
            "kind": "latest",
            "engine": "llamacpp",
            "channel": "nightly",
            "backend": "rocm",
            "fork_id": "llamacpp-rocm-nightly",
            "engine_repository": "lemonade-sdk/llama.cpp",
            "engine_version": "b123",
            "model": "model",
            "scenario": "chat",
            "quant": "Q4",
            "system_id": "system-1",
            "context_size": 1024,
            "input_tokens": 512,
            "measured_at": "2026-10-10T10:00:00Z",
            "run_id": "1",
            "run_url": "https://example.test/performance",
            "lemonade_version": "v1",
            "metrics": {"tps_mean": 10},
            "rocm_version": None,
            "qualification_build_id": None,
            "accuracy_verdict": None,
            "producer_accuracy": {"accuracy": 1},
            "arbitrary_blob": {"hidden": True},
        }
        system = {
            "id": "system-1",
            "source_id": "performance-source",
            "cpu": "CPU",
            "gpu": "GPU",
            "gpu_full": "AMD Radeon 8060S",
            "os": "linux",
            "memory": "32 GB",
            "ram_gb": 32,
            "vram_gb": 96,
            "source_pointer": "/systems/0",
            "arbitrary_blob": {"hidden": True},
        }
        output = normalized(rows, [measurement], [system])
        output["sources"].append(
            {
                "id": "vllm-source",
                "engine": "vllm",
                "status": "stale",
                "record_count": 1,
                "url": SOURCE_B,
            }
        )

        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            index = write_dataset(output, destination)

            self.assertEqual(index["default_version"], "7.15")
            self.assertEqual(
                [item["rocm_version"] for item in index["versions"]],
                ["7.15", "7.14.0", "7.14", "7.9"],
            )
            overview = json.loads((destination / "rocm/7.14/overview.json").read_text())
            llama = next(
                card for card in overview["engines"] if card["id"] == "llamacpp"
            )
            self.assertEqual(llama["build_count"], 5)
            self.assertEqual(
                {row["build_id"] for row in llama["latest_builds"]},
                {"stable-rerun", "stable-windows", "nightly-linux"},
            )
            self.assertEqual(
                [item["month"] for item in overview["history"]],
                ["2026-10", "2026-09"],
            )
            october = json.loads(
                (destination / "rocm/7.14/history/2026-10.json").read_text()
            )
            rerun = next(
                row for row in october["builds"] if row["build_id"] == "stable-rerun"
            )
            self.assertEqual(rerun["tests"], {"passed": 2, "failed": 3, "total": 5})
            self.assertFalse(rerun["qualified"])
            self.assertEqual(rerun["blocking_tests"], ["T0.1"])
            self.assertNotIn("arbitrary_blob", rerun)
            self.assertNotIn("results", rerun)
            self.assertNotIn("summary", rerun)
            self.assertEqual(
                overview["performance"], {"status": "awaiting_attribution"}
            )
            self.assertNotIn("measurements", overview)

            performance = json.loads(
                (destination / "performance/unassigned.json").read_text()
            )
            self.assertEqual(index["unassigned_performance"]["count"], 1)
            self.assertNotIn("producer_accuracy", performance["measurements"][0])
            self.assertNotIn("arbitrary_blob", performance["measurements"][0])
            self.assertEqual(
                performance["systems"][0],
                {
                    "id": "system-1",
                    "source_id": "performance-source",
                    "cpu": "CPU",
                    "gpu": "GPU",
                    "gpu_full": "AMD Radeon 8060S",
                    "os": "linux",
                    "memory": "32 GB",
                    "ram_gb": 32,
                    "vram_gb": 96,
                    "source_pointer": "/systems/0",
                },
            )

    def test_merges_complete_history_across_source_pruning_and_replaces_reruns(self):
        prior = normalized(
            [
                build("unchanged", generated_at="2026-09-01T10:00:00Z"),
                build(
                    "rerun",
                    generated_at="2026-09-02T10:00:00Z",
                    overall="fail",
                    qualified=False,
                ),
                build(
                    "pruned-source",
                    rocm_version="7.13",
                    source_id="legacy-source",
                    generated_at="2026-08-01T10:00:00Z",
                ),
            ]
        )
        prior["sources"].append(
            {
                "id": "legacy-source",
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": 1,
                "url": SOURCE_C,
            }
        )
        prior["measurements"].append(
            {"source_id": "previous-performance", "model": "old-model"}
        )
        current = normalized(
            [
                build(
                    "rerun",
                    generated_at="2026-10-02T10:00:00Z",
                    overall="pass",
                    qualified=True,
                    source_pointer="/builds/9",
                ),
                build("new-current", generated_at="2026-10-03T10:00:00Z"),
            ]
        )
        current["sources"][0]["url"] = SOURCE_B

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous_data = root / "previous"
            destination = root / "current"
            write_dataset(prior, previous_data)
            index = write_dataset(current, destination, previous_data=previous_data)

            self.assertEqual(index["sources"], current["sources"])
            self.assertEqual(
                {
                    item["rocm_version"]: item["build_count"]
                    for item in index["versions"]
                },
                {"7.14": 3, "7.13": 1},
            )
            october = json.loads(
                (destination / "rocm/7.14/history/2026-10.json").read_text()
            )["builds"]
            september = json.loads(
                (destination / "rocm/7.14/history/2026-09.json").read_text()
            )["builds"]
            historic = next(row for row in september if row["build_id"] == "unchanged")
            rerun = next(row for row in october if row["build_id"] == "rerun")
            self.assertEqual(
                historic["source_url"],
                SOURCE_A,
            )
            self.assertEqual(
                rerun["source_url"],
                SOURCE_B,
            )
            self.assertEqual(rerun["overall"], "pass")
            old_version = json.loads(
                (destination / "rocm/7.13/history/2026-08.json").read_text()
            )["builds"]
            self.assertEqual(
                old_version[0]["source_url"],
                SOURCE_C,
            )
            self.assertEqual(index["unassigned_performance"]["count"], 0)

    def test_rejects_incomplete_corrupt_or_escaping_previous_history(self):
        for case in ("status", "count", "traversal", "symlink"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                previous_data = root / "previous"
                write_dataset(normalized([build()]), previous_data)
                index_path = previous_data / "index.json"
                index = json.loads(index_path.read_text())
                overview_path = previous_data / index["versions"][0]["overview"]
                overview = json.loads(overview_path.read_text())
                if case == "status":
                    index["collection_status"] = "degraded"
                    index_path.write_text(json.dumps(index))
                elif case == "count":
                    overview["history"][0]["build_count"] = 2
                    overview_path.write_text(json.dumps(overview))
                elif case == "traversal":
                    index["versions"][0]["overview"] = "../outside.json"
                    index_path.write_text(json.dumps(index))
                else:
                    target = root / "outside.json"
                    target.write_text("{}")
                    link = previous_data / "rocm/7.14/history/linked.json"
                    link.symlink_to(target)
                    overview["history"][0]["path"] = "rocm/7.14/history/linked.json"
                    overview_path.write_text(json.dumps(overview))

                with self.assertRaises(ValueError):
                    write_dataset(
                        normalized([build("current")]), root / "current", previous_data
                    )

    def test_degraded_output_keeps_only_current_diagnostic_builds(self):
        prior = normalized([build("old", rocm_version="7.13")])
        current = normalized(
            [build("diagnostic", rocm_version="7.15")], status="degraded"
        )
        current["sources"][0]["status"] = "error"
        current["sources"][0]["record_count"] = 1

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous_data = root / "previous"
            destination = root / "current"
            write_dataset(prior, previous_data)
            destination.mkdir()
            marker = destination / "unrelated.txt"
            marker.write_text("keep")
            index = write_dataset(current, destination, previous_data=previous_data)

            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(index["sources"], current["sources"])
            self.assertEqual(
                [item["rocm_version"] for item in index["versions"]], ["7.15"]
            )
            self.assertEqual(marker.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()

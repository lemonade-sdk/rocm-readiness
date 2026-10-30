import copy
import tempfile
from pathlib import Path
import unittest
from scripts import execution_dataset
from tests.test_attribution import measurement, evidence
from scripts.attribution import attribute_stable


def attempt(model="model", status="passed", **changes):
    row = measurement(
        model=model,
        scenario="context-32k",
        quant=None,
        context_size=32768,
        system_id="hardware-a",
        backend_args="",
        checkpoints={"main": "org/model"},
        execution_status=status,
        failed_runs=0 if status == "passed" else 1,
        all_runs_failed=status == "failed",
        measurement_runs=3,
        warmup_runs=1,
        hardware={"cpu": "CPU", "gpu": [{"name": "GPU"}], "os": "linux"},
        source_url="https://raw.githubusercontent.com/a/b/"
        + "a" * 40
        + "/results/run.json",
        source_json_sha256="b" * 64,
        source_blob_sha="c" * 40,
    )
    row.update(changes)
    attribute_stable({"measurements": [row]}, [evidence()])
    return row


class ExecutionDatasetTests(unittest.TestCase):
    def test_unique_models_include_failed_and_partial_attempts(self):
        rows = [attempt(), attempt("bad", "failed"), attempt("flaky", "partial")]
        summary = execution_dataset.summarize(rows)[0]
        self.assertEqual(
            (
                summary["passed"],
                summary["total"],
                summary["partial"],
                summary["failed"],
            ),
            (1, 3, 1, 1),
        )
        self.assertEqual(summary["engine_version"], "b123")

    def test_multiple_variants_count_once_and_all_must_pass(self):
        rows = [attempt(), attempt(status="partial", checkpoints={"main": "org/other"})]
        summary = execution_dataset.summarize(rows)[0]
        self.assertEqual(
            (summary["passed"], summary["total"], summary["partial"]), (0, 1, 1)
        )

    def test_unknown_latest_omits_whole_comparable_summary(self):
        self.assertEqual(
            execution_dataset.summarize([attempt(), attempt("unknown", "unknown")]), []
        )

    def test_workloads_and_hardware_do_not_mix(self):
        rows = [
            attempt(),
            attempt("other", "failed", system_id="hardware-b"),
            attempt("small", context_size=4096, scenario="context-4k"),
        ]
        self.assertEqual(len(execution_dataset.summarize(rows)), 3)

    def test_corrupt_count_is_rejected_by_independent_validator(self):
        rows = [attempt(), attempt("bad", "failed")]
        data = {
            "schema_version": 1,
            "rocm_version": "10.1",
            "attempts": rows,
            "summaries": execution_dataset.summarize(rows),
        }
        data["summaries"][0]["passed"] = 2
        with self.assertRaisesRegex(ValueError, "summary"):
            execution_dataset.validate_execution_file(data, "10.1")

    def test_wrong_package_version_cannot_be_published(self):
        row = attempt()
        row["rocm_version"] = "10.0"
        with self.assertRaisesRegex(ValueError, "package"):
            execution_dataset.validate_execution_file(
                {
                    "schema_version": 1,
                    "rocm_version": "10.0",
                    "attempts": [row],
                    "summaries": [],
                },
                "10.0",
            )


class ExecutionProjectionTests(unittest.TestCase):
    def test_dataset_references_execution_file_and_publisher_keeps_it(self):
        from scripts.dataset import write_dataset
        from scripts.publish import manifest
        from tests.test_dataset import normalized, build
        import json

        output = normalized([build(rocm_version="10.1")])
        output["executions"] = [attempt()]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset(output, root)
            overview = json.loads((root / "rocm/10.1/overview.json").read_text())
            self.assertEqual(overview["execution"]["path"], "rocm/10.1/executions.json")
            (root / "provenance").mkdir()
            (root / "provenance/executions.json").write_text("{}")
            (root / "provenance/packages.json").write_text("{}")
            self.assertIn("rocm/10.1/executions.json", manifest(root))
            self.assertNotIn("provenance/executions.json", manifest(root))


class ExecutionCollectorTests(unittest.TestCase):
    def test_enabled_detail_fetch_failure_degrades_collection(self):
        import json
        from scripts.collect import collect
        from unittest.mock import patch

        config = {
            "schema_version": 1,
            "engines": [{"id": "llamacpp"}],
            "sources": [
                {
                    "id": "performance",
                    "engine": "llamacpp",
                    "adapter": "lemonade-leaderboard-v1",
                    "repository": "a/b",
                    "ref": "benchmark-data",
                    "path": "leaderboard.json",
                    "channel": "from-fork",
                    "stale_after_hours": 72,
                    "execution_details": True,
                    "forks": {
                        "llamacpp-rocm-stable": {
                            "engine": "llamacpp",
                            "channel": "stable",
                            "backend": "rocm",
                            "repository": "lemonade-sdk/llama.cpp",
                        }
                    },
                }
            ],
        }

        def fetch(url):
            if "/commits/" in url:
                return {"sha": "a" * 40}
            return {"systems": [], "by_model_scenario": {}, "history": {}}

        with tempfile.TemporaryDirectory() as directory:
            with patch(
                "scripts.collect.collect_executions",
                side_effect=OSError("detail fetch failed"),
            ):
                output = collect(
                    config, Path(directory), fetch=fetch, now="2026-10-30T15:00:00Z"
                )
            self.assertEqual(output["collection_status"], "degraded")
            self.assertEqual(output["sources"][0]["status"], "error")


class ExecutionProvenanceTests(unittest.TestCase):
    def test_projection_cannot_turn_a_real_metricless_failure_into_a_pass(self):
        from scripts.executions import collect_executions
        from tests.test_executions import inventory, fixture, SOURCE, COMMIT

        result = collect_executions(SOURCE, COMMIT, inventory([fixture("failed")])[3])
        rows = result["attempts"]
        proof = {
            "schema_version": 1,
            "sources": [
                {
                    "source_id": SOURCE["id"],
                    "inventory": result["inventory"],
                    "snapshots": result["snapshots"],
                }
            ],
        }
        execution_dataset.validate_execution_provenance(rows, proof)
        rows[0]["execution_status"] = "passed"
        with self.assertRaisesRegex(ValueError, "status mismatch"):
            execution_dataset.validate_execution_provenance(rows, proof)

    def test_changed_raw_document_is_rejected(self):
        from scripts.executions import collect_executions
        from tests.test_executions import inventory, fixture, SOURCE, COMMIT

        result = collect_executions(SOURCE, COMMIT, inventory([fixture("passed")])[3])
        next(iter(result["snapshots"].values()))["fork_version"] = "b0"
        with self.assertRaisesRegex(ValueError, "checksum"):
            execution_dataset.validate_execution_provenance(
                result["attempts"],
                {
                    "sources": [
                        {
                            "source_id": SOURCE["id"],
                            "inventory": result["inventory"],
                            "snapshots": result["snapshots"],
                        }
                    ]
                },
            )


class ExecutionCompletenessTests(unittest.TestCase):
    def test_deleting_latest_failed_attempt_cannot_improve_summary(self):
        from scripts.executions import collect_executions
        from tests.test_executions import inventory, fixture, SOURCE, COMMIT

        result = collect_executions(
            SOURCE, COMMIT, inventory([fixture("passed"), fixture("failed")])[3]
        )
        rows = [dict(r, rocm_version="10.1") for r in result["attempts"]]
        proof = {
            "sources": [
                {
                    "source_id": SOURCE["id"],
                    "inventory": result["inventory"],
                    "snapshots": result["snapshots"],
                }
            ]
        }
        package = evidence(
            run_id="40537509555",
            engine_version="b11932",
            package_url=evidence()["package_url"].replace("b123", "b11932"),
            evidence_url="https://github.com/lemonade-sdk/lemonade/actions/runs/40537509555/job/99",
            started_at="2026-10-27T00:00:00Z",
            completed_at="2026-10-28T00:00:00Z",
        )
        packages = {"packages": [package]}
        execution_dataset.validate_execution_completeness(rows, proof, packages, "10.1")
        rows = [r for r in rows if r["execution_status"] != "failed"]
        with self.assertRaisesRegex(ValueError, "incomplete or stale"):
            execution_dataset.validate_execution_completeness(
                rows, proof, packages, "10.1"
            )


class ExecutionReviewRegressionTests(unittest.TestCase):
    def test_system_id_must_describe_the_actual_raw_hardware(self):
        from scripts.executions import collect_executions
        from tests.test_executions import inventory, fixture, SOURCE, COMMIT

        result = collect_executions(SOURCE, COMMIT, inventory([fixture("passed")])[3])
        result["attempts"][0]["system_id"] = "fake-system"
        with self.assertRaisesRegex(ValueError, "system identity"):
            execution_dataset.validate_execution_provenance(
                result["attempts"],
                {
                    "sources": [
                        {
                            "source_id": SOURCE["id"],
                            "inventory": result["inventory"],
                            "snapshots": result["snapshots"],
                        }
                    ]
                },
            )

    def test_conflicting_explicit_producer_rocm_version_is_rejected(self):
        row = attempt(producer_rocm_version="10.2")
        with self.assertRaisesRegex(ValueError, "producer ROCm"):
            execution_dataset.validate_execution_file(
                {
                    "schema_version": 1,
                    "rocm_version": "10.1",
                    "attempts": [row],
                    "summaries": execution_dataset.summarize([row]),
                },
                "10.1",
            )
        row["producer_rocm_version"] = "10.1.0"
        execution_dataset.validate_execution_file(
            {
                "schema_version": 1,
                "rocm_version": "10.1",
                "attempts": [row],
                "summaries": execution_dataset.summarize([row]),
            },
            "10.1",
        )

    def test_summary_date_uses_actual_time_not_lexical_order(self):
        rows = [
            attempt(measured_at="2026-10-27T10:05:00Z"),
            attempt("later", measured_at="2026-10-27T09:30:00-01:00"),
        ]
        self.assertEqual(
            execution_dataset.summarize(rows)[0]["latest_at"],
            "2026-10-27T09:30:00-01:00",
        )


class PublishedExecutionValidationTests(unittest.TestCase):
    def test_published_projection_validates_without_raw_bodies_but_collection_requires_them(
        self,
    ):
        from scripts.dataset import write_dataset
        from scripts.conformance import validate_dataset
        from scripts.validation import PipelineValidationError
        from tests.test_dataset import normalized, build

        output = normalized([build(rocm_version="10.1")])
        output["executions"] = [attempt()]
        output["sources"].append(
            {
                "id": "performance",
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": 1,
                "url": output["executions"][0]["source_url"],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset(output, root)
            self.assertIn("rocm/10.1/executions.json", validate_dataset(root))
            with self.assertRaises(PipelineValidationError):
                validate_dataset(root, require_execution_evidence=True)


class ExecutionPublicationTests(unittest.TestCase):
    def test_corrupt_execution_summary_cannot_be_published(self):
        import json
        from scripts.dataset import write_dataset
        from scripts.publish import manifest
        from tests.test_dataset import normalized, build

        output = normalized([build(rocm_version="10.1")])
        output["executions"] = [attempt()]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset(output, root)
            path = root / "rocm/10.1/executions.json"
            data = json.loads(path.read_text())
            data["summaries"][0]["passed"] = 99
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "summary"):
                manifest(root)


class ExecutionOnlyVersionTests(unittest.TestCase):
    def test_verified_execution_version_survives_without_qualification_or_speed(self):
        import json
        from scripts.dataset import write_dataset
        from tests.test_dataset import normalized

        output = normalized()
        output["executions"] = [attempt()]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = write_dataset(output, root)
            self.assertEqual([v["rocm_version"] for v in index["versions"]], ["10.1"])
            overview = json.loads((root / "rocm/10.1/overview.json").read_text())
            self.assertEqual(overview["engines"][0]["latest_builds"], [])
            self.assertEqual(overview["execution"]["summaries"][0]["passed"], 1)


class ExecutionVersionCompletenessTests(unittest.TestCase):
    def test_dropping_entire_execution_only_version_is_rejected(self):
        import json
        from scripts.executions import collect_executions
        from scripts.dataset import write_dataset
        from scripts.conformance import validate_dataset
        from scripts.validation import PipelineValidationError
        from tests.test_dataset import normalized, build
        from tests.test_executions import inventory, fixture, SOURCE, COMMIT

        result = collect_executions(SOURCE, COMMIT, inventory([fixture("failed")])[3])
        proof = evidence(
            run_id="40537509555",
            engine_version="b11932",
            package_url=evidence()["package_url"].replace("b123", "b11932"),
            evidence_url="https://github.com/lemonade-sdk/lemonade/actions/runs/40537509555/job/99",
            started_at="2026-10-27T00:00:00Z",
            completed_at="2026-10-28T00:00:00Z",
        )
        rows = result["attempts"]
        attribute_stable({"measurements": rows}, [proof])
        output = normalized([build()])
        output["executions"] = rows
        output["sources"].append(
            {
                "id": SOURCE["id"],
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": 2,
                "url": rows[0]["source_url"],
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset(output, root)
            (root / "provenance").mkdir()
            (root / "provenance/packages.json").write_text(
                json.dumps({"packages": [proof]})
            )
            (root / "provenance/executions.json").write_text(
                json.dumps(
                    {
                        "sources": [
                            {
                                "source_id": SOURCE["id"],
                                "inventory": result["inventory"],
                                "snapshots": result["snapshots"],
                            }
                        ]
                    }
                )
            )
            validate_dataset(root, require_execution_evidence=True)
            path = root / "index.json"
            index = json.loads(path.read_text())
            index["versions"] = [
                v for v in index["versions"] if v["rocm_version"] != "10.1"
            ]
            index["default_version"] = "7.14"
            path.write_text(json.dumps(index))
            with self.assertRaisesRegex(PipelineValidationError, "execution version"):
                validate_dataset(root, require_execution_evidence=True)

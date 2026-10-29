import copy
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

from scripts.conformance import validate_dataset
from scripts.dataset import write_dataset
from scripts.validation import PipelineValidationError
from tests.test_dataset import SOURCE_A, build, normalized
from tests.test_attribution import evidence, measurement
from scripts.attribution import attribute_stable


class ConformanceTests(unittest.TestCase):
    def test_required_nullable_catalog_field_must_be_present(self):
        self.mutate("index.json", lambda data: data.pop("reference_model"))
        self.rejects("index.json", "/reference_model")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rows = [
            build("older", generated_at="2026-09-30T23:59:59Z"),
            build("latest", generated_at="2026-10-01T00:00:00Z"),
        ]
        write_dataset(normalized(self.rows), self.root)

    def mutate(self, path, change):
        target = self.root / path
        data = json.loads(target.read_text())
        change(data)
        target.write_text(json.dumps(data))

    def rejects(self, path, field):
        with self.assertRaises(PipelineValidationError) as caught:
            validate_dataset(self.root)
        self.assertEqual(caught.exception.diagnostic["record"], path)
        self.assertIn(field, caught.exception.diagnostic["field"])
        self.assertTrue(caught.exception.diagnostic["reason"])

    def test_valid_retained_history_and_optional_evidence_fields(self):
        for month in ("2026-09", "2026-10"):
            self.mutate(
                f"rocm/7.14/history/{month}.json",
                lambda d: [
                    row.pop(key, None)
                    for row in d["builds"]
                    for key in ("results", "upstream_sha", "event", "run_id")
                ],
            )
        # Existing optional fields may be absent from historical rows and summaries.
        self.mutate(
            "rocm/7.14/overview.json",
            lambda d: [
                row.pop(key, None)
                for card in d["engines"]
                for row in card["latest_builds"]
                for key in ("results", "upstream_sha", "event", "run_id")
            ],
        )
        self.assertIn("rocm/7.14/history/2026-09.json", validate_dataset(self.root))

    def test_wrong_index_count_is_rejected(self):
        self.mutate("index.json", lambda d: d["versions"][0].update(build_count=99))
        self.rejects("index.json", "/versions/0/build_count")

    def test_wrong_engine_count_is_rejected(self):
        self.mutate(
            "rocm/7.14/overview.json", lambda d: d["engines"][0].update(build_count=0)
        )
        self.rejects("rocm/7.14/overview.json", "/engines/0/build_count")

    def test_wrong_latest_build_is_rejected(self):
        history = json.loads((self.root / "rocm/7.14/history/2026-09.json").read_text())
        self.mutate(
            "rocm/7.14/overview.json",
            lambda d: d["engines"][0].update(latest_builds=history["builds"]),
        )
        self.rejects("rocm/7.14/overview.json", "/engines/0/latest_builds")

    def test_month_must_match_measured_build_date(self):
        self.mutate(
            "rocm/7.14/history/2026-09.json",
            lambda d: d["builds"][0].update(generated_at="2026-10-01T00:00:00Z"),
        )
        self.rejects("rocm/7.14/history/2026-09.json", "/builds/0/generated_at")

    def test_wrong_engine_ownership_is_rejected(self):
        self.mutate(
            "rocm/7.14/history/2026-09.json",
            lambda d: d["builds"][0].update(engine="vllm"),
        )
        self.rejects("rocm/7.14/history/2026-09.json", "/builds/0/engine")

    def test_config_source_scope_is_enforced(self):
        config = {
            "engines": normalized()["engines"],
            "sources": [
                {
                    "id": "llama-source",
                    "engine": "llamacpp",
                    "adapter": "qualification-v1",
                    "repository": "example/source",
                    "channel": "nightly",
                }
            ],
        }
        self.mutate(
            "index.json",
            lambda d: d["sources"][0].update(
                channel="nightly",
                adapter="qualification-v1",
                repository="example/source",
                ref="main",
                commit="a" * 40,
                sha256="0" * 64,
                latest_observation_at="2026-10-01T00:00:00Z",
                age_hours=24,
                stale_after_hours=72,
                destination="rocm/*/history/*.json",
            ),
        )
        with self.assertRaisesRegex(PipelineValidationError, "channel"):
            validate_dataset(self.root, config)

    def test_manifest_path_traversal_is_rejected(self):
        self.mutate(
            "index.json", lambda d: d["versions"][0].update(overview="../outside.json")
        )
        self.rejects("index.json", "/versions/0/overview")

    def test_duplicate_history_identity_is_rejected(self):
        self.mutate(
            "rocm/7.14/history/2026-09.json",
            lambda d: d["builds"].append(copy.deepcopy(d["builds"][0])),
        )
        self.rejects("rocm/7.14/history/2026-09.json", "/builds/1")

    def test_measurement_association_cannot_use_benchmark_run_id(self):
        row = measurement(
            model="fixture",
            scenario="chat",
            quant="Q4",
            system_id=None,
            source_url=SOURCE_A,
            source_id="llama-source",
            metrics={"tg_tps": 12.5},
        )
        ev = evidence()
        attribute_stable({"measurements": [row]}, [ev])
        match = build(
            "qualification-id",
            rocm_version="10.1",
            artifact=ev["package_url"].rsplit("/", 1)[-1],
        )
        data = normalized([match], [row])
        data["sources"][0]["url"] = (
            "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/"
            + "a" * 40
            + "/qualification/index.json"
        )
        row["source_url"] = data["sources"][0]["url"]
        write_dataset(data, self.root)
        validate_dataset(self.root)
        self.mutate(
            "rocm/10.1/performance.json",
            lambda d: d["measurements"][0].update(qualification_build_id="42"),
        )
        self.rejects(
            "rocm/10.1/performance.json", "/measurements/0/qualification_build_id"
        )

    def test_latest_pointer_commit_and_url_must_agree(self):
        (self.root / "latest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "data_commit": "a" * 40,
                    "index_url": "https://raw.githubusercontent.com/example/repo/"
                    + "b" * 40
                    + "/data/index.json",
                }
            )
        )
        self.rejects("latest.json", "/index_url")

    def test_malformed_identity_and_url_have_field_diagnostics(self):
        path = "rocm/7.14/history/2026-09.json"
        original = (self.root / path).read_text()
        for field, value in (
            ("source_id", []),
            ("engine", {}),
            ("report_url", "https://[invalid"),
        ):
            with self.subTest(field=field):
                (self.root / path).write_text(original)
                self.mutate(path, lambda d: d["builds"][0].update({field: value}))
                self.rejects(path, "/builds/0/" + field)

    def test_current_source_revision_does_not_replace_retained_evidence_revision(self):
        self.mutate(
            "index.json",
            lambda d: d["sources"][0].update(url=SOURCE_A.replace("a" * 40, "b" * 40)),
        )
        validate_dataset(self.root)

    def test_live_failed_attempt_can_keep_successful_dataset_snapshot(self):
        generated = "2026-10-02T12:00:00Z"
        successful = {
            "attempted_at": generated,
            "status": "success",
            "last_successful_at": generated,
            "errors": [],
        }
        self.mutate("index.json", lambda d: d.update(sync=successful))
        before = (self.root / "index.json").read_bytes()
        failure = {
            "attempted_at": "2026-10-03T12:00:00Z",
            "status": "failed",
            "last_successful_at": generated,
            "errors": [
                {
                    "source_id": "llama-source",
                    "record": "",
                    "field": "fetch",
                    "reason": "offline",
                }
            ],
        }
        (self.root / "sync.json").write_text(
            json.dumps({"schema_version": 1, "sync": failure})
        )
        (self.root / "latest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "data_commit": "a" * 40,
                    "index_url": "https://raw.githubusercontent.com/example/repo/"
                    + "a" * 40
                    + "/data/index.json",
                    "sync": failure,
                }
            )
        )
        validate_dataset(self.root)
        self.assertEqual((self.root / "index.json").read_bytes(), before)
        self.mutate("latest.json", lambda d: d.update(sync=successful))
        self.rejects("latest.json", "/sync")

    def test_comparison_partition_contract_and_invalid_attribution(self):
        row = measurement(
            model="fixture",
            scenario="chat",
            quant="Q4",
            system_id=None,
            source_id="llama-source",
            source_url=SOURCE_A,
            metrics={"tg_tps": 15},
            channel="reference",
            backend="vulkan",
            attribution=None,
        )
        write_dataset(normalized(self.rows, [row]), self.root)
        self.assertIn("performance/comparisons.json", validate_dataset(self.root))
        self.mutate(
            "performance/comparisons.json",
            lambda d: d["measurements"][0].update(rocm_version="7.14"),
        )
        self.rejects("performance/comparisons.json", "/measurements/0/rocm_version")

    def test_real_pinned_producer_excerpt_conforms(self):
        from tests.test_pinned_mappings import normalized as pinned_normalized

        output = pinned_normalized()
        for source in output["sources"]:
            source.update(
                engine="llamacpp",
                status="fresh",
                record_count=5 if source["id"].endswith("qualification") else 2,
            )
        write_dataset(output, self.root)
        self.assertIn("rocm/10.1/performance.json", validate_dataset(self.root))

    def test_negative_metrics_rejected_even_when_latest_summary_agrees(self):
        from tests.test_pinned_mappings import normalized as pinned_normalized

        output = pinned_normalized()
        for source in output["sources"]:
            source.update(
                engine="llamacpp",
                status="fresh",
                record_count=5 if source["id"].endswith("qualification") else 2,
            )
        write_dataset(output, self.root)
        path = "rocm/10.1/performance.json"
        self.mutate(path, lambda d: d["measurements"][0]["metrics"].update(tg_tps=-1))
        self.mutate(
            "rocm/10.1/overview.json",
            lambda d: d["performance"]["latest_measurements"][0]["metrics"].update(
                tg_tps=-1
            ),
        )
        self.rejects(path, "/measurements/0/metrics")

    def test_configured_qualification_report_remains_on_original_commit(self):
        from tests.test_pinned_mappings import normalized as pinned_normalized

        output = pinned_normalized()
        for source in output["sources"]:
            source.update(
                engine="llamacpp",
                status="fresh",
                record_count=5 if source["id"].endswith("qualification") else 2,
            )
            if source["id"].endswith("qualification"):
                source["adapter"] = "qualification-v1"
        write_dataset(output, self.root)
        validate_dataset(self.root)
        path = "rocm/10.1/history/2026-10.json"
        self.mutate(
            path,
            lambda d: d["builds"][0].update(
                report_url="https://example.test/unrelated-report.json"
            ),
        )
        self.rejects(path, "/builds/0/report_url")

    def test_published_pointer_requires_live_attempt_status(self):
        (self.root / "latest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "data_commit": "a" * 40,
                    "index_url": "https://raw.githubusercontent.com/example/repo/"
                    + "a" * 40
                    + "/data/index.json",
                }
            )
        )
        self.rejects("latest.json", "/sync")

    def test_cli_returns_contextual_failure(self):
        self.mutate("index.json", lambda d: d["versions"][0].update(build_count=999))
        result = subprocess.run(
            [sys.executable, "scripts/conformance.py", "--data-dir", str(self.root)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("record=index.json", result.stderr)
        self.assertIn("/versions/0/build_count", result.stderr)


if __name__ == "__main__":
    unittest.main()

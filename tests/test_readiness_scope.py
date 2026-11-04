"""Owner-selected stable/upcoming scope is enforced in generated app data."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.config import load_config
from scripts.dataset import write_dataset
from scripts.conformance import validate_dataset
from scripts.publish import manifest
from scripts.validation import PipelineValidationError
from tests.test_dataset import normalized, build
from tests.test_execution_dataset import attempt


class ReadinessScopeTests(unittest.TestCase):
    def test_shared_qualification_index_skips_old_reports_before_normalizing(self):
        from scripts.collect import normalize_qualification
        from tests.test_collect import fixture

        data = fixture("llama.json")
        current = copy.deepcopy(data["builds"][0])
        current["rocm_version"] = "10.1"
        current["build_id"] = "current"
        data["builds"] = [
            {"rocm_version": "10.0", "generated_at": "irrelevant old report"},
            current,
        ]
        source = {"id": "llama-source", "engine": "llamacpp", "channel": "stable"}
        rows = normalize_qualification(
            source, data, "https://example.com/data.json", {"stable_anchor": "10.1"}
        )
        self.assertEqual([r["rocm_version"] for r in rows], ["10.1"])

    def test_config_is_carried_into_collector_policy(self):
        config, _ = load_config(json.loads(Path("sources.json").read_text()))
        self.assertEqual(config["readiness"], {"stable_anchor": "latest", "nightly_limit": 2})

    def test_all_engines_scope_previous_history_order_and_regeneration(self):
        versions = ["7.14", "10.0", "10.1", "10.2", "10.3", "10.10"]
        rows = [
            build(
                f"{engine}-{version}",
                rocm_version=version,
                engine=engine,
                source_id="llama-source" if engine == "llamacpp" else "vllm-source",
            )
            for engine in ("llamacpp", "vllm")
            for version in versions
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            initial = normalized(rows)
            initial["sources"].append(
                {
                    "id": "vllm-source",
                    "engine": "vllm",
                    "status": "fresh",
                    "record_count": 6,
                    "url": initial["sources"][0]["url"],
                }
            )
            write_dataset(initial, root)
            output_sources = initial["sources"]
            output = normalized()
            output["sources"] = output_sources
            output["readiness"] = {"stable_anchor": "10.1"}
            index = write_dataset(output, root, root)
            self.assertEqual(
                [v["rocm_version"] for v in index["versions"]],
                ["10.1", "10.2", "10.3", "10.10"],
            )
            self.assertEqual(index["default_version"], "10.1")
            self.assertFalse((root / "rocm/7.14").exists())
            self.assertFalse((root / "rocm/10.0").exists())
            self.assertEqual(index["readiness"], output["readiness"])
            paths = validate_dataset(root)
            self.assertEqual(paths, manifest(root))
            for path in paths:
                if path.startswith("rocm/"):
                    self.assertIn(path.split("/")[1], ["10.1", "10.2", "10.3", "10.10"])
            # Advancing scope does not resurrect older retained history.
            output["readiness"] = {"stable_anchor": "10.2"}
            index = write_dataset(output, root, root)
            self.assertEqual(
                [v["rocm_version"] for v in index["versions"]],
                ["10.2", "10.3", "10.10"],
            )
            self.assertFalse((root / "rocm/10.1").exists())
            validate_dataset(root)

    def test_failed_partial_unknown_and_performance_survive_only_in_selected_tracks(
        self,
    ):
        attempts = [
            attempt(status, status)
            for status in ("passed", "failed", "partial", "unknown")
        ]
        old = copy.deepcopy(attempts[1])
        old["rocm_version"] = (
            "10.0"  # Out-of-scope evidence is never rendered or validated as current.
        )
        measurements = [
            {
                **attempts[0],
                "kind": "latest",
                "system_id": None,
                "metrics": {"tg_tps": 5},
            },
            {**old, "kind": "latest", "system_id": None, "metrics": {"tg_tps": 1}},
        ]
        output = normalized(measurements=measurements)
        output["readiness"] = {"stable_anchor": "10.1"}
        output["executions"] = attempts + [old]
        output["sources"].append(
            {
                "id": "performance",
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": 5,
                "url": attempts[0]["source_url"],
            }
        )
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            index = write_dataset(output, root)
            self.assertEqual([v["rocm_version"] for v in index["versions"]], ["10.1"])
            detail = json.loads((root / "rocm/10.1/executions.json").read_text())
            self.assertCountEqual(
                [r["execution_status"] for r in detail["attempts"]],
                ["passed", "failed", "partial", "unknown"],
            )
            performance = json.loads((root / "rocm/10.1/performance.json").read_text())
            self.assertEqual(
                {r["rocm_version"] for r in performance["measurements"]}, {"10.1"}
            )
            self.assertFalse((root / "rocm/10.0").exists())
            validate_dataset(root)

    def test_conformance_and_publication_reject_leftover_old_generated_tracks(self):
        output = normalized([build(rocm_version="10.1")])
        output["readiness"] = {"stable_anchor": "10.1"}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(output, root)
            (root / "rocm/10.0").mkdir()
            for validate in (validate_dataset, manifest):
                with self.subTest(validator=validate.__name__), self.assertRaises(
                    PipelineValidationError
                ):
                    validate(root)

    def test_publication_replaces_old_tracks_and_failed_refresh_keeps_last_good(self):
        from scripts import publish
        from tests.test_publish import seed_remote

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote = seed_remote(root)
            work, previous, state = (
                root / "work",
                root / "previous",
                root / "state.json",
            )
            old = root / "old"
            new = root / "new"
            sync = {
                "attempted_at": "2026-10-02T12:00:00Z",
                "status": "success",
                "last_successful_at": "2026-10-02T12:00:00Z",
                "errors": [],
            }

            def complete(path):
                index = json.loads((path / "index.json").read_text())
                index["sync"] = sync
                (path / "index.json").write_text(json.dumps(index))
                (path / "sync.json").write_text(
                    json.dumps({"schema_version": 1, "sync": sync})
                )

            write_dataset(
                normalized(
                    [build(rocm_version="10.0"), build("current", rocm_version="10.1")]
                ),
                old,
            )
            complete(old)
            publish.restore(str(remote), "main", work, previous, state)
            self.assertTrue(
                publish.publish(str(remote), "main", "owner/repo", work, old, state)
            )
            publish.restore(str(remote), "main", work, previous, state)
            self.assertTrue((previous / "rocm/10.0").exists())
            output = normalized()
            output["readiness"] = {"stable_anchor": "10.1"}
            write_dataset(output, new, previous)
            complete(new)
            self.assertTrue(
                publish.publish(str(remote), "main", "owner/repo", work, new, state)
            )
            publish.restore(str(remote), "main", work, previous, state)
            self.assertFalse((previous / "rocm/10.0").exists())
            self.assertTrue((previous / "rocm/10.1/overview.json").exists())
            pointer = json.loads((previous / "latest.json").read_text())["data_commit"]
            # A bad refresh cannot publish an empty/degraded replacement.
            (new / "rocm/10.0").mkdir()
            self.assertFalse(
                publish.publish(str(remote), "main", "owner/repo", work, new, state)
            )
            publish.restore(str(remote), "main", work, previous, state)
            self.assertEqual(
                json.loads((previous / "latest.json").read_text())["data_commit"],
                pointer,
            )
            self.assertFalse((previous / "rocm/10.0").exists())

    def test_execution_links_require_unique_exact_package_build_identity(self):
        execution = attempt("bad", "failed")
        qualification = build(
            "exact",
            rocm_version="10.1",
            artifact=execution["package_url"].rsplit("/", 1)[-1],
        )
        for changes, duplicate, expected in [
            ({}, False, "exact"),
            ({"os": "windows"}, False, None),
            ({"channel": "nightly"}, False, None),
            ({"source_id": "other-source"}, False, None),
            ({"rocm_version": "10.2"}, False, None),
            ({"artifact": "other-package.tar.gz"}, False, None),
            ({"tag": "other-tag"}, False, None),
            ({}, True, None),
        ]:
            with self.subTest(
                changes=changes, duplicate=duplicate
            ), tempfile.TemporaryDirectory() as folder:
                rows = [{**qualification, **changes}]
                if duplicate:
                    rows.append({**rows[0], "build_id": "rerun"})
                output = normalized(rows)
                output["sources"][0]["url"] = (
                    "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/"
                    + "a" * 40
                    + "/qualification/index.json"
                )
                output["sources"].append(
                    {
                        "id": "performance",
                        "engine": "llamacpp",
                        "status": "fresh",
                        "record_count": 1,
                        "url": execution["source_url"],
                    }
                )
                output["sources"].append(
                    {
                        "id": "other-source",
                        "engine": "llamacpp",
                        "status": "fresh",
                        "record_count": 1,
                        "url": "https://raw.githubusercontent.com/other/repo/"
                        + "a" * 40
                        + "/qualification.json",
                    }
                )
                output["readiness"] = {"stable_anchor": "10.1"}
                output["executions"] = [execution]
                root = Path(folder)
                write_dataset(output, root)
                saved = json.loads((root / "rocm/10.1/executions.json").read_text())[
                    "attempts"
                ][0]
                self.assertEqual(saved["qualification_build_id"], expected)
                self.assertEqual(saved["execution_status"], "failed")
                validate_dataset(root)
                # A forged association must not survive conformance/publication.
                if expected is None:
                    detail = json.loads(
                        (root / "rocm/10.1/executions.json").read_text()
                    )
                    detail["attempts"][0]["qualification_build_id"] = "exact"
                    (root / "rocm/10.1/executions.json").write_text(json.dumps(detail))
                    with self.assertRaises(PipelineValidationError):
                        validate_dataset(root)

    def test_scope_is_configured_not_maximum_and_absent_tracks_not_invented(self):
        output = normalized([build(rocm_version="10.10")])
        output["readiness"] = {"stable_anchor": "10.1"}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            index = write_dataset(output, root)
            self.assertEqual(index["readiness"]["stable_anchor"], "10.1")
            self.assertEqual([v["rocm_version"] for v in index["versions"]], ["10.10"])
            validate_dataset(root)
            index["versions"].append(
                {
                    "rocm_version": "10.0",
                    "overview": "rocm/10.0/overview.json",
                    "build_count": 1,
                }
            )
            (root / "index.json").write_text(json.dumps(index))
            with self.assertRaises(PipelineValidationError):
                validate_dataset(root)

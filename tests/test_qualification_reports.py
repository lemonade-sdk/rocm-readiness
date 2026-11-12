"""Downstream collection prepares UI evidence from immutable producer reports."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.qualification_reports import prepare_report, collect_reports
from scripts.dataset import write_dataset
from tests.test_dataset import build, normalized

URL = (
    "https://raw.githubusercontent.com/example/source/"
    + "a" * 40
    + "/qualification/reports/build.json"
)


class QualificationReportsTests(unittest.TestCase):
    def report(self, details):
        return {
            "build": {"os": "linux"},
            "tiers": {
                "tier1": {
                    "tests": [
                        {"id": "T1.10", "details": details},
                        {"id": "T1.2"},
                        {"name": "unnumbered"},
                    ]
                }
            },
        }

    def test_prepares_proof_and_order_without_mutating_raw_audit(self):
        details = {
            "gpu_proof": ["using device ROCm0", "ROCm0 model buffer size = 358.78 MiB"],
            "requested_offload_line": "offloaded 29/29 layers to GPU",
        }
        raw = self.report(details)
        original = copy.deepcopy(raw)
        prepared = prepare_report(raw)
        tests = prepared["tiers"]["tier1"]["tests"]
        self.assertEqual([t.get("id") for t in tests], ["T1.2", "T1.10", None])
        self.assertEqual([t["source_index"] for t in tests], [1, 0, 2])
        self.assertEqual(
            tests[1]["display_evidence"],
            [
                {
                    "label": "GPU offload",
                    "value": "using device ROCm0, ROCm0 model buffer size = 358.78 MiB",
                }
            ],
        )
        self.assertEqual(tests[1]["details"], details)
        self.assertEqual(raw, original)

    def test_only_positive_gpu_buffers_are_presented_as_gpu_execution(self):
        details = {
            "devices_selected": [{"device": "ROCm0", "name": "Radeon"}],
            "model_buffers_mib": [["CPU", 50], ["ROCm0", 0], ["ROCm1", 2.5]],
            "requested_offload_line": "offloaded 29/29 layers to GPU",
        }
        tests = prepare_report(self.report(details))["tiers"]["tier1"]["tests"]
        self.assertEqual(
            tests[1]["display_evidence"],
            [{"label": "GPU offload", "value": "ROCm1: 2.5 MiB model buffer"}],
        )
        details["model_buffers_mib"] = [["CPU", 50], ["ROCm0", 0]]
        tests = prepare_report(self.report(details))["tiers"]["tier1"]["tests"]
        self.assertEqual(tests[1]["display_evidence"], [])

    def test_requested_layers_alone_are_audit_only(self):
        tests = prepare_report(
            self.report({"requested_offload_line": "offloaded 29/29 layers to GPU"})
        )["tiers"]["tier1"]["tests"]
        self.assertEqual(tests[1]["display_evidence"], [])

    def test_pinned_fetch_is_deduplicated_and_survives_publication(self):
        calls = []

        def fetch(url):
            calls.append(url)
            return self.report({"model_buffers_mib": [["ROCm0", 1]]})

        rows = [build(report_url=URL), build("second", report_url=URL)]
        collect_reports(rows, {"llama-source"}, fetch)
        self.assertEqual(calls, [URL])
        self.assertEqual(rows[0]["report_snapshot"]["source_url"], URL)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(normalized(rows), root)
            history = json.loads((root / "rocm/7.14/history/2026-10.json").read_text())
            reference = history["builds"][0]["report_snapshot"]
            self.assertNotIn("report", reference)
            self.assertEqual(
                json.loads((root / reference["path"]).read_text()),
                rows[0]["report_snapshot"],
            )
            from scripts.publish import manifest

            self.assertIn(reference["path"], manifest(root))
            write_dataset(normalized([]), root / "next", previous_data=root)
            self.assertTrue((root / "next" / reference["path"]).is_file())

    def test_report_failure_is_explicit_and_does_not_drop_build(self):
        rows = [build(report_url=URL)]

        def fetch(url):
            raise OSError("offline")

        collect_reports(rows, {"llama-source"}, fetch)
        self.assertEqual(rows[0]["report_snapshot"]["source_url"], URL)
        self.assertIn("offline", rows[0]["report_snapshot"]["error"])
        self.assertNotIn("report", rows[0]["report_snapshot"])

    def test_sources_without_report_collection_remain_compatible(self):
        rows = [build(report_url=URL)]
        collect_reports(rows, set(), lambda _: self.fail("unexpected fetch"))
        self.assertNotIn("report_snapshot", rows[0])

    def test_collection_publishes_prepared_reports_for_enabled_sources(self):
        from scripts.collect import collect
        from tests.test_collect import CollectionTests, fixture

        config = CollectionTests().config()
        config["sources"][0]["report_details"] = True
        calls = []

        def fetch(url):
            calls.append(url)
            if "/commits/" in url:
                return {"sha": "a" * 40}
            if "/qualification/reports/" in url:
                return self.report({"model_buffers_mib": [["ROCm0", 1]]})
            return fixture("llama.json")

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = collect(config, root, fetch, now="2026-10-29T18:00:00Z")
            self.assertTrue(output["builds"])
            for row in output["builds"]:
                self.assertEqual(
                    row["report_snapshot"]["source_url"], row["report_url"]
                )
                self.assertIn("/" + "a" * 40 + "/", row["report_url"])
                self.assertEqual(
                    row["report_snapshot"]["report"]["tiers"]["tier1"]["tests"][1][
                        "display_evidence"
                    ],
                    [{"label": "GPU offload", "value": "ROCm0: 1 MiB model buffer"}],
                )
            histories = list(root.glob("rocm/*/history/*.json"))
            self.assertTrue(histories)
            for path in histories:
                for row in json.loads(path.read_text())["builds"]:
                    self.assertIn("report_snapshot", row)

    def test_malformed_reports_and_unpinned_urls_are_explicit_failures(self):
        for url, document in [
            (URL, {}),
            ("https://example.test/report.json", self.report({})),
        ]:
            rows = [build(report_url=url)]
            collect_reports(rows, {"llama-source"}, lambda _: document)
            self.assertIn("error", rows[0]["report_snapshot"])
            self.assertNotIn("report", rows[0]["report_snapshot"])

    def test_publication_rejects_corrupt_or_missing_linked_reports(self):
        from scripts.publish import manifest

        for mutation in ("corrupt", "missing"):
            with (
                self.subTest(mutation=mutation),
                tempfile.TemporaryDirectory() as folder,
            ):
                root = Path(folder)
                rows = [build(report_url=URL)]
                collect_reports(rows, {"llama-source"}, lambda _: self.report({}))
                write_dataset(normalized(rows), root)
                report = next((root / "reports").glob("*.json"))
                if mutation == "corrupt":
                    report.write_text(report.read_text() + " ")
                    with self.assertRaisesRegex(ValueError, "content hash"):
                        manifest(root)
                else:
                    report.unlink()
                    with self.assertRaises((OSError, ValueError)):
                        manifest(root)

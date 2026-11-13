"""Collector-owned qualification presentation remains scoped to missing Tier 1 hardware."""
import json
import tempfile
import unittest
from pathlib import Path

from scripts.dataset import write_dataset
from scripts.conformance import validate_dataset
from scripts.validation import PipelineValidationError
from tests.test_dataset import build, normalized


class QualificationOutcomeTests(unittest.TestCase):
    def write(self, **changes):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        row = build(hardware_validated=False, tier1="not_applicable", results={
            "T1.1": "not_applicable", "T1.2": "skip", "T0.11": "not_applicable",
        })
        row.update(changes)
        write_dataset(normalized([row]), root)
        path = "rocm/7.14/history/2026-10.json"
        history = json.loads((root / path).read_text())
        return root, path, history

    def test_writer_emits_scoped_labels_in_history_and_overview(self):
        root, path, history = self.write()
        expected = {"tiers": {"tier1": "no hardware available"},
                    "checks": {"T1.1": "no hardware available"}}
        self.assertEqual(history["builds"][0]["qualification_labels"], expected)
        overview = json.loads((root / "rocm/7.14/overview.json").read_text())
        self.assertEqual(overview["engines"][0]["latest_builds"][0]["qualification_labels"], expected)
        validate_dataset(root)

    def test_gate_requires_literal_false_and_not_applicable(self):
        for changes in [{"hardware_validated": True}, {"hardware_validated": None},
                        {"tier1": "skip", "results": {"T1.1": "skip", "T0.11": "not_applicable"}},
                        {"tier1": "pass", "results": {"T1.1": "pass"}}]:
            with self.subTest(changes=changes):
                _, _, history = self.write(**changes)
                self.assertEqual(history["builds"][0]["qualification_labels"], {"tiers": {}, "checks": {}})

    def test_conformance_rejects_wrong_text_wrong_tier_and_wrong_type(self):
        for value in [None, "no hardware available", {"tiers": {}, "checks": {"T0.11": "no hardware available"}},
                      {"tiers": {"tier1": "wrong copy"}, "checks": {}}]:
            with self.subTest(value=value):
                root, path, history = self.write()
                history["builds"][0]["qualification_labels"] = value
                (root / path).write_text(json.dumps(history))
                with self.assertRaises(PipelineValidationError) as caught:
                    validate_dataset(root)
                self.assertIn("qualification_labels", caught.exception.diagnostic["field"])

    def test_older_snapshots_without_labels_remain_valid(self):
        root, path, history = self.write()
        history["builds"][0].pop("qualification_labels")
        (root / path).write_text(json.dumps(history))
        overview_path = root / "rocm/7.14/overview.json"
        overview = json.loads(overview_path.read_text())
        overview["engines"][0]["latest_builds"][0].pop("qualification_labels")
        overview_path.write_text(json.dumps(overview))
        validate_dataset(root)

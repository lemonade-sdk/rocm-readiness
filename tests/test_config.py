import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

from scripts import collect

ROOT = Path(__file__).resolve().parents[1]


class ConfigurationTests(unittest.TestCase):
    def load(self, config):
        self.assertTrue(hasattr(collect, "load_config"), "unified loader missing")
        return collect.load_config(config)

    def test_repository_unified_config_projects_views(self):
        readiness, upstream = self.load(json.loads((ROOT / "sources.json").read_text()))
        self.assertEqual(readiness["schema_version"], 1)
        self.assertEqual(len(readiness["sources"]), 3)
        self.assertEqual(len(upstream["projects"]), 6)
        self.assertEqual(upstream["projects"][0]["id"], "llamacpp")

    def test_v1_has_no_implicit_upstream(self):
        config = {"schema_version": 1, "engines": [], "sources": []}
        self.assertIsNone(self.load(config)[1])

    def test_v1_cli_does_not_collect_upstream(self):
        config = {
            "schema_version": 1,
            "engines": [
                {"id": "llamacpp", "label": "llama.cpp", "platforms": ["linux"]}
            ],
            "sources": [
                {
                    "id": "pending",
                    "engine": "llamacpp",
                    "adapter": "qualification-v1",
                    "availability": "awaiting_data",
                    "channel": "nightly",
                }
            ],
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "custom.json"
            path.write_text(json.dumps(config))
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/collect.py"),
                    "--sources",
                    str(path),
                    "--output-dir",
                    str(root / "out"),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("Upstream health:", result.stdout)
            self.assertFalse((root / "out/upstream").exists())

    def test_rejects_invalid_cross_references(self):
        original = json.loads((ROOT / "sources.json").read_text())
        mutations = [
            lambda c: c["projects"].append(copy.deepcopy(c["projects"][0])),
            lambda c: c["sources"].append(copy.deepcopy(c["sources"][0])),
            lambda c: c["sources"][0].update(project="unknown"),
            lambda c: c["sources"][0].update(adapter="github-actions-v1"),
            lambda c: c["sources"].append(
                {**copy.deepcopy(c["sources"][3]), "id": "other-upstream"}
            ),
            lambda c: c["views"]["readiness"]["sources"].append("unknown"),
            lambda c: c["views"]["upstream"]["sources"].append(
                c["views"]["readiness"]["sources"][0]
            ),
            lambda c: c["views"]["readiness"]["sources"].append(
                c["views"]["readiness"]["sources"][0]
            ),
        ]
        for mutate in mutations:
            config = copy.deepcopy(original)
            mutate(config)
            with self.subTest(mutation=mutate), self.assertRaises(ValueError):
                self.load(config)

    def test_readiness_view_must_be_explicit(self):
        original = json.loads((ROOT / "sources.json").read_text())
        for misspelled in (False, True):
            config = copy.deepcopy(original)
            readiness = config["views"].pop("readiness")
            if misspelled:
                config["views"]["readines"] = readiness
            with self.subTest(misspelled=misspelled), self.assertRaisesRegex(
                ValueError, "readiness"
            ):
                self.load(config)
        original["views"]["readiness"]["sources"] = []
        self.assertEqual(self.load(original)[0]["sources"], [])

    def test_conformance_rejects_upstream_only_sources(self):
        _, upstream = self.load(json.loads((ROOT / "sources.json").read_text()))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upstream.json"
            path.write_text(json.dumps(upstream))
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/conformance.py"),
                    "--data-dir",
                    str(ROOT / "data"),
                    "--sources",
                    str(path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no readiness", result.stderr)

"""The configured Vulkan baseline stays independent of ROCm qualification."""

import json
import copy
from pathlib import Path
import tempfile
import unittest

from scripts.collect import normalize_performance
from scripts.config import load_config
from scripts.dataset import write_dataset
from scripts.conformance import validate_dataset
from tests.test_dataset import normalized


class VulkanProjectionTests(unittest.TestCase):
    def test_production_config_projects_pinned_reference_without_rocm_assignment(self):
        config, _ = load_config(json.loads(Path("sources.json").read_text()))
        source = next(s for s in config["sources"] if s["id"] == "lemonade-performance")
        fixture = json.loads(Path("tests/fixtures/vulkan-reference.json").read_text())
        rows = normalize_performance(source, fixture["document"])
        self.assertEqual(len(rows), 2)
        row = rows[0]
        self.assertEqual(row["fork_id"], "llamacpp-upstream-vulkan")
        self.assertEqual(row["engine_repository"], "ggml-org/llama.cpp")
        self.assertEqual(row["channel"], "reference")
        self.assertEqual(row["model"], "Gemma-4-31B-it-GGUF")
        self.assertEqual(row["context_size"], 32768)
        self.assertEqual(row["input_tokens"], 24035)
        self.assertEqual(row["quant"], "Q4_K_M")
        self.assertEqual(row["engine_version"], "b11946")
        for measurement in rows:
            measurement["source_url"] = fixture["source_url"]
        systems = [
            {**system, "source_id": source["id"], "source_pointer": f"/systems/{i}"}
            for i, system in enumerate(fixture["document"]["systems"])
        ]
        output = normalized(measurements=rows, systems=systems)
        output["readiness"] = config["readiness"]
        output["sources"] = [
            {
                "id": source["id"],
                "engine": "llamacpp",
                "status": "fresh",
                "record_count": len(rows),
                "url": fixture["source_url"],
            }
        ]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            index = write_dataset(output, root)
            self.assertEqual(index["versions"], [])
            self.assertEqual(index["stable_performance"]["assigned_count"], 0)
            self.assertEqual(
                index["comparison_performance"],
                {"count": 1, "path": "performance/comparisons.json"},
            )
            detail = json.loads(
                (root / index["comparison_performance"]["path"]).read_text()
            )
            saved = detail["measurements"][0]
            for field in (
                "rocm_version",
                "qualification_build_id",
                "package_os",
                "package_url",
                "runtime_version",
            ):
                self.assertIsNone(saved[field], field)
            self.assertEqual(saved["source_url"], fixture["source_url"])
            self.assertEqual(saved["source_pointer"], fixture["source_pointer"] + "/0")
            self.assertEqual(saved["metrics"]["tg_tps"], 9.25)
            self.assertEqual(saved["run_url"], row["run_url"])
            self.assertEqual(detail["systems"][0]["os"], "linux")
            self.assertTrue(detail["systems"][0]["gpu_full"][0]["integrated"])
            validate_dataset(root)
            # Ordering of the producer's latest/history copies cannot drop the
            # more complete system/context or change its source pointer.
            output["measurements"] = rows[::-1]
            write_dataset(output, root)
            self.assertEqual(
                json.loads((root / "performance/comparisons.json").read_text()), detail
            )
            validate_dataset(root)
            # Same observation identity with incompatible settings is a real
            # contract conflict, not another copy safe to discard.
            for field, value in (
                ("context_size", 4096),
                ("input_tokens", 1),
                ("system_id", "different-system"),
            ):
                conflict = copy.deepcopy(rows)
                conflict[1][field] = value
                output["measurements"] = conflict
                with self.subTest(field=field), self.assertRaisesRegex(
                    ValueError, "conflicting comparison"
                ):
                    write_dataset(output, root)

import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from scripts.check import main


class CheckTests(unittest.TestCase):
    def test_failed_test_gate_records_failed_sync_without_running_ingestion(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "index.json").write_text(
                json.dumps(
                    {
                        "collection_status": "complete",
                        "generated_at": "2026-10-01T00:00:00Z",
                    }
                )
            )
            with patch("sys.argv", ["check.py", "--output-dir", str(root)]), patch(
                "scripts.check.subprocess.run",
                return_value=SimpleNamespace(returncode=1),
            ) as run:
                self.assertEqual(main(), 1)
            self.assertEqual(run.call_count, 1)
            index = json.loads((root / "index.json").read_text())
            self.assertEqual(index["collection_status"], "degraded")
            self.assertEqual(index["sync"]["status"], "failed")
            self.assertEqual(
                index["sync"]["last_successful_at"], "2026-10-01T00:00:00Z"
            )
            self.assertEqual(index["sync"]["errors"][0]["field"], "tests")
            self.assertEqual(
                json.loads((root / "sync.json").read_text())["sync"], index["sync"]
            )

    def test_first_attribution_upgrade_rebuilds_without_previous_dataset(self):
        for marker, reuse in ((None, False), (2, True)):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                previous = root / "previous"
                previous.mkdir()
                (previous / "index.json").write_text(
                    json.dumps({"attribution_version": marker})
                )
                with patch(
                    "sys.argv",
                    [
                        "check.py",
                        "--output-dir",
                        str(root / "new"),
                        "--previous-data",
                        str(previous),
                    ],
                ), patch(
                    "scripts.check.subprocess.run",
                    return_value=SimpleNamespace(returncode=0),
                ) as run:
                    self.assertEqual(main(), 0)
                command = run.call_args_list[-1].args[0]
                self.assertEqual("--previous-data" in command, reuse)

    def test_fresh_collection_does_not_carry_previous_records(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = root / "previous"
            previous.mkdir()
            (previous / "index.json").write_text(json.dumps({"attribution_version": 2}))
            with patch(
                "sys.argv",
                [
                    "check.py",
                    "--fresh",
                    "--output-dir",
                    str(root / "new"),
                    "--previous-data",
                    str(previous),
                ],
            ), patch(
                "scripts.check.subprocess.run",
                return_value=SimpleNamespace(returncode=0),
            ) as run:
                self.assertEqual(main(), 0)
            command = run.call_args_list[-1].args[0]
            self.assertNotIn("--previous-data", command)

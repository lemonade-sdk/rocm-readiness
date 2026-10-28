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

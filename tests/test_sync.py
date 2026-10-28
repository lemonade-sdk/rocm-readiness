import json
from pathlib import Path
import tempfile
import unittest

from scripts.sync import load_last_success, publish_sync
from scripts.validation import PipelineValidationError


class SyncTests(unittest.TestCase):
    def test_success_failure_success_keeps_last_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = publish_sync(root, "2026-10-01T00:00:00Z", "success", None, [])
            self.assertEqual(first["last_successful_at"], "2026-10-01T00:00:00Z")
            prior = load_last_success(root)
            error = {
                "source_id": "x",
                "record": "/a",
                "field": "fetch",
                "reason": "offline",
            }
            failed = publish_sync(
                root, "2026-10-02T00:00:00Z", "failed", prior, [error]
            )
            self.assertEqual(failed["last_successful_at"], "2026-10-01T00:00:00Z")
            self.assertEqual(failed["errors"], [error])
            final = publish_sync(
                root, "2026-10-03T00:00:00Z", "success", load_last_success(root), []
            )
            self.assertEqual(final["last_successful_at"], "2026-10-03T00:00:00Z")
            self.assertEqual(
                json.loads((root / "sync.json").read_text())["sync"], final
            )

    def test_migrates_old_complete_index_and_rejects_malformed_sync(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = root / "previous"
            previous.mkdir()
            (previous / "index.json").write_text(
                json.dumps(
                    {
                        "collection_status": "complete",
                        "generated_at": "2026-09-30T01:00:00Z",
                    }
                )
            )
            self.assertEqual(
                load_last_success(root / "new", previous), "2026-09-30T01:00:00Z"
            )
            (previous / "sync.json").write_text('{"schema_version": 1, "sync": {}}')
            with self.assertRaises(PipelineValidationError):
                load_last_success(root / "new", previous)

    def test_failed_current_without_last_success_uses_previous_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            publish_sync(root / "current", "2026-10-02T00:00:00Z", "failed", None, [])
            publish_sync(root / "previous", "2026-10-01T00:00:00Z", "success", None, [])
            self.assertEqual(
                load_last_success(root / "current", root / "previous"),
                "2026-10-01T00:00:00Z",
            )

    def test_unavailable_previous_is_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertIsNone(load_last_success(root, root / "missing"))

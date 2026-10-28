import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts import publish
from scripts.dataset import write_dataset
from tests.test_dataset import build, normalized


class PublicationTest(unittest.TestCase):
    def test_two_cycles_and_failure_preserve_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            subprocess.run(
                ["git", "init", "--bare", str(remote)], check=True, capture_output=True
            )
            dataset = root / "data"
            dataset.mkdir()
            state = root / "state.json"
            prev = root / "previous"

            def write(status):
                sync = {
                    "attempted_at": "2026-01-01T00:00:00Z",
                    "status": status,
                    "last_successful_at": (
                        "2026-01-01T00:00:00Z" if status == "success" else None
                    ),
                    "errors": [],
                }
                (dataset / "sync.json").write_text(
                    json.dumps({"schema_version": 1, "sync": sync})
                )
                (dataset / "index.json").write_text(
                    json.dumps(
                        {
                            "schema_version": 2,
                            "collection_status": "complete",
                            "versions": [],
                            "sources": [],
                            "sync": sync,
                            "unassigned_performance": {
                                "count": 0,
                                "path": "performance/unassigned.json",
                            },
                        }
                    )
                )
                (dataset / "performance").mkdir(exist_ok=True)
                (dataset / "performance/unassigned.json").write_text(
                    json.dumps({"schema_version": 2, "measurements": [], "systems": []})
                )
                (dataset / "raw").mkdir(exist_ok=True)
                (dataset / "raw/secret.json").write_text("{}")

            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            write("success")
            self.assertTrue(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            first = json.loads((prev / "latest.json").read_text())["data_commit"]
            self.assertFalse((prev / "raw").exists())
            self.assertTrue(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            second = json.loads((prev / "latest.json").read_text())["data_commit"]
            self.assertNotEqual(first, second)
            write("failed")
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            pointer = json.loads((prev / "latest.json").read_text())
            self.assertEqual(pointer["data_commit"], second)
            self.assertEqual(pointer["sync"]["status"], "failed")
            self.assertEqual(
                pointer["sync"]["last_successful_at"], "2026-01-01T00:00:00Z"
            )
            sync_path = dataset / "sync.json"
            failed = json.loads(sync_path.read_text())
            failed["sync"]["last_successful_at"] = "2099-01-01T00:00:00Z"
            sync_path.write_text(json.dumps(failed))
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            pointer = json.loads((prev / "latest.json").read_text())
            self.assertEqual(
                pointer["sync"]["last_successful_at"], "2026-01-01T00:00:00Z"
            )
            failed["sync"]["attempted_at"] = "2025-01-01T00:00:00Z"
            sync_path.write_text(json.dumps(failed))
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "dashboard-data", root / "work", prev, state)
            latest = json.loads((prev / "latest.json").read_text())
            self.assertEqual(latest["data_commit"], second)
            self.assertEqual(
                latest["sync"]["last_successful_at"], "2026-01-01T00:00:00Z"
            )
            self.assertGreaterEqual(
                latest["sync"]["attempted_at"], pointer["sync"]["attempted_at"]
            )
            self.assertIn("stale", latest["sync"]["errors"][0]["reason"])

    def test_version_history_and_snapshot_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            subprocess.run(
                ["git", "init", "--bare", str(remote)], check=True, capture_output=True
            )
            data = root / "data"
            output = normalized([build()])
            output["sources"][0]["snapshot"] = "raw/secret.json"
            write_dataset(output, data)
            (data / "sync.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "sync": {
                            "attempted_at": "2026-01-01T00:00:00Z",
                            "status": "success",
                            "last_successful_at": "2026-01-01T00:00:00Z",
                            "errors": [],
                        },
                    }
                )
            )
            for relative in (
                "raw/secret.json",
                "provenance/packages.json",
                "errors.json",
                "publication-state.json",
            ):
                path = data / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}")
            index_path = data / "index.json"
            index = json.loads(index_path.read_text())
            index["sync"] = json.loads((data / "sync.json").read_text())["sync"]
            index_path.write_text(json.dumps(index))
            state = root / "state.json"
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            self.assertTrue(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    data,
                    state,
                )
            )
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            previous = root / "previous"
            self.assertTrue((previous / "rocm/7.14/history/2026-10.json").is_file())
            self.assertNotIn(
                "snapshot",
                json.loads((previous / "index.json").read_text())["sources"][0],
            )
            for relative in (
                "raw",
                "provenance",
                "errors.json",
                "publication-state.json",
            ):
                self.assertFalse((previous / relative).exists())

    def test_first_failure_and_stale_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            subprocess.run(
                ["git", "init", "--bare", str(remote)], check=True, capture_output=True
            )
            state = root / "state.json"
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            )
            with self.assertRaisesRegex(ValueError, "changed since restore"):
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            latest = json.loads((root / "previous/latest.json").read_text())
            self.assertIsNone(latest["data_commit"])
            self.assertIsNone(latest["index_url"])
            self.assertIsNone(latest["sync"]["last_successful_at"])
            self.assertEqual(latest["sync"]["status"], "failed")

    def test_remote_deletion_between_check_and_push_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            subprocess.run(
                ["git", "init", "--bare", str(remote)], check=True, capture_output=True
            )
            state = root / "state.json"
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "dashboard-data",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            )
            publish.restore(
                str(remote), "dashboard-data", root / "work", root / "previous", state
            )
            original_git = publish.git

            def delete_then_push(cwd, *args, **kwargs):
                if args[0] == "push":
                    subprocess.run(
                        [
                            "git",
                            "--git-dir",
                            str(remote),
                            "update-ref",
                            "-d",
                            "refs/heads/dashboard-data",
                        ],
                        check=True,
                    )
                return original_git(cwd, *args, **kwargs)

            with patch.object(publish, "git", side_effect=delete_then_push):
                with self.assertRaisesRegex(ValueError, "git push failed"):
                    publish.publish(
                        str(remote),
                        "dashboard-data",
                        "owner/repo",
                        root / "work",
                        root / "missing",
                        state,
                    )
            self.assertIsNone(publish.remote_head(str(remote), "dashboard-data"))

    def test_missing_remote_is_not_missing_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "cannot read remote"):
                publish.restore(
                    str(root / "absent"),
                    "dashboard-data",
                    root / "work",
                    root / "previous",
                    root / "state.json",
                )
            self.assertFalse((root / "state.json").exists())

    def test_manifest_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "real.json").write_text("{}")
            (root / "index.json").symlink_to(root / "real.json")
            with self.assertRaisesRegex(ValueError, "symlink"):
                publish.manifest(root)


class PublicationGuardTests(unittest.TestCase):
    def test_source_branches_cannot_be_publication_targets(self):
        for branch in ("main", "master"):
            with self.subTest(branch=branch), self.assertRaisesRegex(
                ValueError, "data branch"
            ):
                publish.remote_head("/irrelevant/remote", branch)


if __name__ == "__main__":
    unittest.main()

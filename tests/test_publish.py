import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts import publish
from scripts.dataset import write_dataset
from tests.test_dataset import build, normalized


def seed_remote(root):
    remote = root / "remote.git"
    source = root / "source"
    subprocess.run(
        ["git", "init", "--bare", str(remote)], check=True, capture_output=True
    )
    source.mkdir()
    subprocess.run(
        ["git", "init", "-b", "main"], cwd=source, check=True, capture_output=True
    )
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.test"], cwd=source, check=True
    )
    for path, contents in {
        "README.md": "source readme\n",
        "code.py": "source code\n",
        ".github/workflows/test.yml": "workflow\n",
        ".gitignore": "data/\n",
    }.items():
        target = source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)
    subprocess.run(["git", "add", "."], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "Initial source"], cwd=source, check=True)
    subprocess.run(["git", "push", "-q", str(remote), "main"], cwd=source, check=True)
    return remote


class PublicationTest(unittest.TestCase):
    def test_two_cycles_and_failure_preserve_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
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

            publish.restore(str(remote), "main", root / "work", prev, state)
            write("success")
            expected = publish.remote_head(str(remote), "main")
            real_git = publish.git
            staged = []

            def inspect_squash(cwd, *args, **kwargs):
                result = real_git(cwd, *args, **kwargs)
                if args[0] == "commit" and "Stage dashboard data" in args:
                    staged.append(real_git(cwd, "rev-parse", "HEAD").stdout.strip())
                if args[0] == "push":
                    self.assertEqual(
                        real_git(
                            cwd,
                            "merge-base",
                            "--is-ancestor",
                            staged[0],
                            "HEAD",
                            check=False,
                        ).returncode,
                        1,
                    )
                return result

            with patch.object(publish, "git", side_effect=inspect_squash):
                published = publish.publish(
                    str(remote), "main", "owner/repo", root / "work", dataset, state
                )
            self.assertTrue(published)
            self.assertEqual(len(staged), 1)
            publish.restore(str(remote), "main", root / "work", prev, state)
            first = json.loads((prev / "latest.json").read_text())["data_commit"]
            head = publish.remote_head(str(remote), "main")
            self.assertEqual(
                publish.git(
                    None, "--git-dir", str(remote), "rev-parse", f"{head}^"
                ).stdout.strip(),
                first,
            )
            self.assertEqual(
                publish.git(
                    None, "--git-dir", str(remote), "rev-parse", f"{first}^"
                ).stdout.strip(),
                expected,
            )
            files = subprocess.run(
                ["git", "--git-dir", str(remote), "ls-tree", "-r", "--name-only", head],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.splitlines()
            for path in (
                "README.md",
                "code.py",
                ".github/workflows/test.yml",
                ".gitignore",
                "data/index.json",
                "data/latest.json",
            ):
                self.assertIn(path, files)
            self.assertEqual(
                subprocess.run(
                    ["git", "--git-dir", str(remote), "show", f"{head}:code.py"],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout,
                "source code\n",
            )
            self.assertTrue(
                json.loads((prev / "latest.json").read_text())["index_url"].endswith(
                    f"/{first}/data/index.json"
                )
            )
            self.assertFalse((prev / "raw").exists())
            self.assertTrue(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
            second = json.loads((prev / "latest.json").read_text())["data_commit"]
            self.assertNotEqual(first, second)
            before_failure = publish.remote_head(str(remote), "main")
            write("failed")
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
            pointer = json.loads((prev / "latest.json").read_text())
            after_failure = publish.remote_head(str(remote), "main")
            changed = subprocess.run(
                [
                    "git",
                    "--git-dir",
                    str(remote),
                    "diff",
                    "--name-only",
                    before_failure,
                    after_failure,
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.splitlines()
            self.assertEqual(changed, ["data/latest.json"])
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
                    "main",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
            pointer = json.loads((prev / "latest.json").read_text())
            self.assertEqual(
                pointer["sync"]["last_successful_at"], "2026-01-01T00:00:00Z"
            )
            failed["sync"]["attempted_at"] = "2025-01-01T00:00:00Z"
            sync_path.write_text(json.dumps(failed))
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
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
            remote = seed_remote(root)
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
                str(remote), "main", root / "work", root / "previous", state
            )
            self.assertTrue(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    data,
                    state,
                )
            )
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
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
            remote = seed_remote(root)
            state = root / "state.json"
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
            )
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            )
            with self.assertRaisesRegex(ValueError, "changed since restore"):
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
            )
            latest = json.loads((root / "previous/latest.json").read_text())
            self.assertIsNone(latest["data_commit"])
            self.assertIsNone(latest["index_url"])
            self.assertIsNone(latest["sync"]["last_successful_at"])
            self.assertEqual(latest["sync"]["status"], "failed")

    def test_remote_deletion_between_check_and_push_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
            state = root / "state.json"
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
            )
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    root / "missing",
                    state,
                )
            )
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
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
                            "refs/heads/main",
                        ],
                        check=True,
                    )
                return original_git(cwd, *args, **kwargs)

            with patch.object(publish, "git", side_effect=delete_then_push):
                with self.assertRaisesRegex(ValueError, "git push failed"):
                    publish.publish(
                        str(remote),
                        "main",
                        "owner/repo",
                        root / "work",
                        root / "missing",
                        state,
                    )
            self.assertIsNone(publish.remote_head(str(remote), "main"))

    def test_failed_collection_cannot_republish_old_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
            dataset = root / "dataset"
            write_dataset(normalized([build()]), dataset)
            sync = {
                "attempted_at": "2026-01-01T00:00:00Z",
                "status": "success",
                "last_successful_at": "2026-01-01T00:00:00Z",
                "errors": [],
            }
            (dataset / "sync.json").write_text(
                json.dumps({"schema_version": 1, "sync": sync})
            )
            index = json.loads((dataset / "index.json").read_text())
            index["sync"] = sync
            (dataset / "index.json").write_text(json.dumps(index))
            state = root / "state.json"
            prev = root / "previous"
            publish.restore(str(remote), "main", root / "work", prev, state)
            self.assertTrue(
                publish.publish(
                    str(remote), "main", "owner/repo", root / "work", dataset, state
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
            prior = json.loads((prev / "latest.json").read_text())
            self.assertFalse(
                publish.publish(
                    str(remote),
                    "main",
                    "owner/repo",
                    root / "work",
                    dataset,
                    state,
                    collection_result="failure",
                )
            )
            publish.restore(str(remote), "main", root / "work", prev, state)
            latest = json.loads((prev / "latest.json").read_text())
            self.assertEqual(latest["data_commit"], prior["data_commit"])
            self.assertEqual(latest["sync"]["status"], "failed")
            self.assertEqual(latest["sync"]["last_successful_at"], sync["attempted_at"])
            self.assertIn("collection", latest["sync"]["errors"][0]["reason"])

    def test_concurrent_source_commit_rejects_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
            state = root / "state.json"
            publish.restore(
                str(remote), "main", root / "work", root / "previous", state
            )
            source = root / "source"
            original_git = publish.git

            def advance_then_push(cwd, *args, **kwargs):
                if args[0] == "push":
                    (source / "code.py").write_text("concurrent code\n")
                    subprocess.run(["git", "add", "code.py"], cwd=source, check=True)
                    subprocess.run(
                        ["git", "commit", "-qm", "Concurrent source"],
                        cwd=source,
                        check=True,
                    )
                    subprocess.run(
                        ["git", "push", "-q", str(remote), "main"],
                        cwd=source,
                        check=True,
                    )
                return original_git(cwd, *args, **kwargs)

            with patch.object(publish, "git", side_effect=advance_then_push):
                with self.assertRaisesRegex(ValueError, "git push failed"):
                    publish.publish(
                        str(remote),
                        "main",
                        "owner/repo",
                        root / "work",
                        root / "missing",
                        state,
                    )
            head = publish.remote_head(str(remote), "main")
            result = subprocess.run(
                ["git", "--git-dir", str(remote), "show", f"{head}:code.py"],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.stdout, "concurrent code\n")

    def test_restore_rejects_stale_source_but_accepts_data_only_advance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
            source = root / "source"
            source_commit = publish.remote_head(str(remote), "main")
            data_file = source / "data" / "latest.json"
            data_file.parent.mkdir()
            data_file.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "data_commit": None,
                        "index_url": None,
                        "sync": {
                            "attempted_at": "2026-01-01T00:00:00Z",
                            "status": "failed",
                            "last_successful_at": None,
                            "errors": [],
                        },
                    }
                )
            )
            subprocess.run(
                ["git", "add", "-f", "data/latest.json"], cwd=source, check=True
            )
            subprocess.run(
                ["git", "commit", "-qm", "Data only"], cwd=source, check=True
            )
            subprocess.run(
                ["git", "push", "-q", str(remote), "main"], cwd=source, check=True
            )
            state = root / "state.json"
            publish.restore(
                str(remote),
                "main",
                root / "work",
                root / "previous",
                state,
                source_commit=source_commit,
            )
            self.assertTrue(state.exists())
            (source / "code.py").write_text("new code\n")
            subprocess.run(["git", "add", "code.py"], cwd=source, check=True)
            subprocess.run(
                ["git", "commit", "-qm", "Code changed"], cwd=source, check=True
            )
            subprocess.run(
                ["git", "push", "-q", str(remote), "main"], cwd=source, check=True
            )
            with self.assertRaisesRegex(ValueError, "source.*changed"):
                publish.restore(
                    str(remote),
                    "main",
                    root / "work",
                    root / "previous",
                    state,
                    source_commit=source_commit,
                )
            self.assertFalse(state.exists())
            with self.assertRaisesRegex(ValueError, "source commit"):
                publish.restore(
                    str(remote),
                    "main",
                    root / "work",
                    root / "previous",
                    state,
                    source_commit="a" * 40,
                )
            self.assertFalse(state.exists())

    def test_missing_main_and_non_main_target_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "empty.git"
            subprocess.run(
                ["git", "init", "--bare", str(remote)], check=True, capture_output=True
            )
            with self.assertRaisesRegex(ValueError, "main branch does not exist"):
                publish.restore(
                    str(remote),
                    "main",
                    root / "work",
                    root / "previous",
                    root / "state.json",
                )
            with self.assertRaisesRegex(ValueError, "target must be main"):
                publish.restore(
                    str(remote),
                    "dashboard-data",
                    root / "work",
                    root / "previous",
                    root / "state.json",
                )

    def test_missing_remote_is_not_missing_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "cannot read remote"):
                publish.restore(
                    str(root / "absent"),
                    "main",
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


if __name__ == "__main__":
    unittest.main()

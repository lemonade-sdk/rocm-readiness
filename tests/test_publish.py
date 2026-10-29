import hashlib
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts import publish
from scripts.attribution import attribute_stable
from tests.test_attribution import evidence, measurement
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
                            "attribution_version": 2,
                            "collection_status": "complete",
                            "versions": [],
                            "sources": [],
                            "sync": sync,
                            "comparison_performance": {
                                "count": 0,
                                "path": "performance/comparisons.json",
                            },
                        }
                    )
                )
                (dataset / "performance").mkdir(exist_ok=True)
                (dataset / "performance/comparisons.json").write_text(
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
            self.assertEqual(changed, ["data/latest.json", "data/sync.json"])
            live_sync = json.loads(
                publish.git(
                    None,
                    "--git-dir",
                    str(remote),
                    "show",
                    f"{after_failure}:data/sync.json",
                ).stdout
            )["sync"]
            self.assertEqual(live_sync, pointer["sync"])
            pinned_sync = json.loads(
                publish.git(
                    None, "--git-dir", str(remote), "show", f"{second}:data/sync.json"
                ).stdout
            )["sync"]
            self.assertEqual(pinned_sync["status"], "success")
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
            head = publish.remote_head(str(remote), "main")
            live_sync = json.loads(
                publish.git(
                    None, "--git-dir", str(remote), "show", f"{head}:data/sync.json"
                ).stdout
            )["sync"]
            self.assertEqual(live_sync, latest["sync"])

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

    def test_manifest_accepts_only_versioned_performance(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(normalized(), root)
            index = json.loads((root / "index.json").read_text())
            index.pop("comparison_performance", None)
            (root / "index.json").write_text(json.dumps(index))
            comparison = root / "performance/comparisons.json"
            comparison.unlink(missing_ok=True)
            self.assertEqual(publish.manifest(root), {"index.json"})

    def test_manifest_rejects_rocm_rows_in_comparisons(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(normalized(), root)
            index = json.loads((root / "index.json").read_text())
            index["comparison_performance"] = {
                "count": 1,
                "path": "performance/comparisons.json",
            }
            (root / "performance").mkdir()
            (root / "index.json").write_text(json.dumps(index))
            row = {
                "source_id": "bench",
                "fork_id": "vulkan",
                "engine_version": "b123",
                "model": "model",
                "scenario": "chat",
                "measured_at": "2026-10-01T00:00:00Z",
                "backend": "rocm",
                "rocm_version": "7.14",
            }
            (root / "performance/comparisons.json").write_text(
                json.dumps({"schema_version": 2, "measurements": [row], "systems": []})
            )
            with self.assertRaisesRegex(ValueError, "cannot claim ROCm"):
                publish.manifest(root)

    def test_manifest_accepts_legacy_unassigned_for_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(normalized(), root)
            index = json.loads((root / "index.json").read_text())
            index["unassigned_performance"] = {
                "count": 0,
                "path": "performance/unassigned.json",
            }
            (root / "performance").mkdir()
            (root / "performance/unassigned.json").write_text(
                json.dumps({"schema_version": 2, "measurements": [], "systems": []})
            )
            (root / "index.json").write_text(json.dumps(index))
            self.assertIn(
                "performance/unassigned.json", publish.manifest(root, allow_legacy=True)
            )
            with self.assertRaisesRegex(ValueError, "attribution|legacy|partition"):
                publish.manifest(root)

    def test_cached_registry_evidence_survives_publication_and_restore(self):
        row = measurement(
            channel="nightly",
            fork_id="llamacpp-rocm-nightly",
            engine_repository="lemonade-sdk/llamacpp-rocm",
            engine_version="b1356",
            model="model",
            scenario="chat",
            source_url="https://raw.githubusercontent.com/lemonade-sdk/lemonade/"
            + "a" * 40
            + "/leaderboard.json",
        )
        package = "https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b1356/llama-b1356-ubuntu-rocm-gfx1151-x64.zip"
        body = json.dumps(
            {
                "forks": [
                    {
                        "fork_id": row["fork_id"],
                        "repo": row["engine_repository"],
                        "arch": "gfx1151",
                        "binary_url_linux": package.replace("b1356", "{version}"),
                    }
                ]
            }
        )
        registry = {
            "url": "https://raw.githubusercontent.com/lemonade-sdk/lemonade/"
            + "b" * 40
            + "/src/cpp/resources/benchmark_forks.json",
            "body": body,
            "sha256": hashlib.sha256(body.encode()).hexdigest(),
        }
        runtime_body = "**ROCm Version**: 10.3.0a20261027"
        item = evidence(
            fork_id=row["fork_id"],
            engine_repository=row["engine_repository"],
            engine_version=row["engine_version"],
            package_url=package,
            scope="all_available_attempts",
            measurement_times=[row["measured_at"]],
            runtime_evidence={
                "url": "https://api.github.com/repos/lemonade-sdk/llamacpp-rocm/releases/tags/b1356",
                "body": runtime_body,
                "sha256": hashlib.sha256(runtime_body.encode()).hexdigest(),
            },
            job_evidence=[
                {
                    "job_id": "99",
                    "evidence_url": row["run_url"] + "/job/99",
                    "package_url": package,
                    "log_sha256": "a" * 64,
                    "method": "cached_binary_registry_match",
                    "registry_evidence": registry,
                }
            ],
        )
        attribute_stable({"measurements": [row]}, [item])
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote = seed_remote(root)
            data = root / "data"
            write_dataset(normalized(measurements=[row]), data)
            sync = {
                "attempted_at": "2026-10-28T00:00:00Z",
                "status": "success",
                "last_successful_at": "2026-10-28T00:00:00Z",
                "errors": [],
            }
            index = json.loads((data / "index.json").read_text())
            index["sync"] = sync
            (data / "index.json").write_text(json.dumps(index))
            (data / "sync.json").write_text(
                json.dumps({"schema_version": 1, "sync": sync})
            )
            previous = root / "previous"
            state = root / "state.json"
            publish.restore(str(remote), "main", root / "work", previous, state)
            self.assertTrue(
                publish.publish(
                    str(remote), "main", "owner/repo", root / "work", data, state
                )
            )
            publish.restore(str(remote), "main", root / "work", previous, state)
            path = previous / "rocm/10.3.0/performance.json"
            restored = json.loads(path.read_text())
            final = restored["measurements"][0]
            self.assertEqual(final["attribution"]["job_evidence"], item["job_evidence"])
            self.assertEqual(
                final["attribution"]["job_evidence"][0]["registry_evidence"], registry
            )
            self.assertEqual(final["runtime_version"], "10.3.0a20261027")
            self.assertIsNone(final["qualification_build_id"])
            final["attribution"]["job_evidence"][0]["registry_evidence"]["sha256"] = (
                "0" * 64
            )
            path.write_text(json.dumps(restored))
            with self.assertRaisesRegex(ValueError, "registry checksum"):
                publish.manifest(previous)
            self.assertFalse(
                publish.publish(
                    str(remote), "main", "owner/repo", root / "work", previous, state
                )
            )

    def test_new_publication_requires_current_attribution_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(normalized(), root)
            index = json.loads((root / "index.json").read_text())
            index.pop("attribution_version")
            (root / "index.json").write_text(json.dumps(index))
            with self.assertRaisesRegex(ValueError, "attribution"):
                publish.manifest(root)
            self.assertEqual(publish.manifest(root, allow_legacy=True), {"index.json"})

    def test_legacy_dataset_restores_but_cannot_publish_as_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote = seed_remote(root)
            source = root / "source"
            data = source / "data"
            write_dataset(normalized(), data)
            index = json.loads((data / "index.json").read_text())
            index.pop("attribution_version")
            index["unassigned_performance"] = {
                "count": 0,
                "path": "performance/unassigned.json",
            }
            (data / "performance").mkdir()
            (data / "performance/unassigned.json").write_text(
                json.dumps({"schema_version": 2, "measurements": [], "systems": []})
            )
            sync = {
                "attempted_at": "2026-01-01T00:00:00Z",
                "status": "success",
                "last_successful_at": "2026-01-01T00:00:00Z",
                "errors": [],
            }
            index["sync"] = sync
            (data / "index.json").write_text(json.dumps(index))
            (data / "sync.json").write_text(
                json.dumps({"schema_version": 1, "sync": sync})
            )
            publish.git(source, "add", "-f", "data")
            publish.git(source, "commit", "-qm", "Legacy data")
            commit = publish.git(source, "rev-parse", "HEAD").stdout.strip()
            (data / "latest.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "data_commit": commit,
                        "index_url": f"https://raw.githubusercontent.com/owner/repo/{commit}/data/index.json",
                        "sync": sync,
                    }
                )
            )
            publish.git(source, "add", "-f", "data/latest.json")
            publish.git(source, "commit", "-qm", "Legacy pointer")
            publish.git(source, "push", "-q", str(remote), "main")
            state = root / "state.json"
            previous = root / "previous"
            publish.restore(str(remote), "main", root / "work", previous, state)
            self.assertTrue((previous / "performance/unassigned.json").exists())
            self.assertFalse(
                publish.publish(
                    str(remote), "main", "owner/repo", root / "work", previous, state
                )
            )
            publish.restore(str(remote), "main", root / "work", previous, state)
            latest = json.loads((previous / "latest.json").read_text())
            self.assertEqual(latest["data_commit"], commit)
            self.assertEqual(latest["sync"]["status"], "failed")
            self.assertIn("attribution", latest["sync"]["errors"][0]["reason"])

    def test_manifest_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "real.json").write_text("{}")
            (root / "index.json").symlink_to(root / "real.json")
            with self.assertRaisesRegex(ValueError, "symlink"):
                publish.manifest(root)


if __name__ == "__main__":
    unittest.main()

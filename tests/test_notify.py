import json
import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.notify import (
    GitCheckpoint, channel_callbacks, main, publish_document, trusted_run,
)
from scripts.notification_channels import DispatchResult, parse_notification_config
from scripts.notification_channels import ApiError, JsonAPI
from scripts.notifications import dispatch
from tests.test_publish import seed_remote


class NotifyRunnerTests(unittest.TestCase):
    def config(self):
        return parse_notification_config(json.dumps({
            "schema_version": 1,
            "github": {"enabled": True, "targets": ["fixture-owner"]},
        }))

    def test_trust_rejects_pr_fork_and_local_execution(self):
        trusted = {
            "GITHUB_ACTIONS": "true", "GITHUB_REF": "refs/heads/main",
            "GITHUB_REPOSITORY": "owner/repo", "GITHUB_EVENT_NAME": "workflow_run",
        }
        self.assertTrue(trusted_run(trusted, "owner/repo"))
        for key, value in (
            ("GITHUB_ACTIONS", "false"), ("GITHUB_REF", "refs/pull/1/merge"),
            ("GITHUB_REPOSITORY", "fork/repo"), ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_EVENT_NAME", "schedule"),
        ):
            self.assertFalse(trusted_run({**trusted, key: value}, "owner/repo"))

    def test_preview_does_not_change_live_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "latest.json").write_text('{"data_commit":"original"}')
            publish_document(root, root / "preview.json", {"assessments": []}, "owner/repo")
            self.assertEqual(json.loads((root / "latest.json").read_text()),
                             {"data_commit": "original"})

    def test_checkpoint_pushes_intent_without_unrelated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = seed_remote(root)
            source = root / "source"
            subprocess.run(["git", "remote", "add", "origin", str(remote)],
                           cwd=source, check=True)
            data = source / "data"
            data.mkdir()
            (data / "notification-state.json").write_text('{"intent":"uncertain"}')
            (source / "unrelated.txt").write_text("never published")
            with patch("scripts.notify.Path.cwd", return_value=source):
                checkpoint = GitCheckpoint(data, data / "notifications.json")
                checkpoint()
            result = subprocess.run(
                ["git", "--git-dir", str(remote), "show", "main:data/notification-state.json"],
                check=True, capture_output=True, text=True,
            )
            self.assertEqual(json.loads(result.stdout), {"intent": "uncertain"})
            files = subprocess.run(
                ["git", "--git-dir", str(remote), "ls-tree", "-r", "--name-only", "main"],
                check=True, capture_output=True, text=True,
            ).stdout
            self.assertNotIn("unrelated.txt", files)

    def test_checkpoint_refuses_preexisting_staged_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seed_remote(root)
            source = root / "source"
            (source / "code.py").write_text("unrelated staged change\n")
            subprocess.run(["git", "add", "code.py"], cwd=source, check=True)
            with patch("scripts.notify.Path.cwd", return_value=source):
                checkpoint = GitCheckpoint(source / "data", source / "data/notifications.json")
                with self.assertRaisesRegex(RuntimeError, "checkpoint git diff failed"):
                    checkpoint()

    def test_engine_label_is_selected_by_exact_source_without_changing_identity(self):
        with patch("scripts.notify.GitHubTransport") as transport:
            transport.return_value.deliver.return_value = DispatchResult("accepted")
            _, github, _ = channel_callbacks(
                self.config(), "owner/repo", {},
                labels_by_source={"llamacpp-upstream": "engine:llamacpp", "vllm-upstream": "engine:vllm"},
            )
            for source, labels in (
                ("llamacpp-upstream", ("engine:llamacpp",)),
                ("vllm-upstream", ("engine:vllm",)), ("unmapped-upstream", ()),
            ):
                github({
                    "id": "stable-id", "summary": "failed", "explanation": "unknown",
                    "scope": {"source_id": source},
                }, {"github": {"attempts": 1}})
                message = transport.return_value.deliver.call_args.args[0]
                self.assertEqual(message.labels, labels)
                self.assertEqual(message.incident_id, "stable-id")

    def test_cli_malformed_private_configuration_is_sanitized_and_preview_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rules = root / "rules.json"
            rules.write_text('{"schema_version":1,"rules":[]}')
            errors, output = io.StringIO(), io.StringIO()
            with patch.dict("os.environ", {
                "ROCM_READINESS_NOTIFICATION_LIST": "private@example.test",
            }, clear=True), patch("scripts.notify.evaluate_dataset", return_value=[]), \
                    redirect_stderr(errors), redirect_stdout(output):
                result = main([
                    "--dataset", str(root), "--rules", str(rules),
                    "--output", str(root / "preview.json"),
                ])
            self.assertEqual(result, 0)
            self.assertNotIn("private@", errors.getvalue() + output.getvalue())
            self.assertTrue(json.loads((root / "preview.json").read_text())["dry_run"])
            self.assertFalse((root / "notification-state.json").exists())

    def test_unknown_skip_creates_an_investigation_with_scope_evidence_and_no_invented_cause(self):
        issues = []

        def request(api, method, path, payload=None, headers=None):
            if method == "GET":
                return list(issues)
            self.assertEqual(method, "POST")
            issues.append({
                **payload, "number": 1, "state": "open",
                "html_url": "https://github.com/owner/repo/issues/1",
            })
            return issues[-1]

        row = {
            "id": "unknown-skip", "summary": "Job skipped; cause unknown.",
            "explanation": "No verified condition or failed prerequisite explains the skip.",
            "scope": {"repository": "org/engine", "job": "gpu-smoke", "workflow": "ci.yml",
                      "source_id": "test", "platform": "linux", "date": "2026-11-17"},
            "actionable": True, "classification": "unexplained", "observed": {"status": "skip"},
            "evidence": [{"label": "Job log", "url": "https://github.com/org/engine/actions/runs/10"}],
        }
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            JsonAPI, "request", autospec=True, side_effect=request,
        ):
            policy, github, reconcile = channel_callbacks(self.config(), "owner/repo", {"GH_TOKEN": "fixture"})
            options = dict(policy=policy, github=github, reconcile=reconcile,
                           trusted=True, dry_run=False, baseline=False)
            state = Path(tmp) / "state.json"
            dispatch([row], state, "2026-11-17T17:00:00Z", **options)
            dispatch([row], state, "2026-11-17T18:00:00Z", **options)
        self.assertEqual(len(issues), 1)
        self.assertIn("cause unknown", issues[0]["title"])
        self.assertIn("No verified condition or failed prerequisite explains the skip.", issues[0]["body"])
        self.assertIn("| Workflow | ci.yml |", issues[0]["body"])
        self.assertIn("[Job log](https://github.com/org/engine/actions/runs/10)", issues[0]["body"])

    def test_cli_live_requires_durable_trusted_checkpoint(self):
        with patch.dict("os.environ", {}, clear=True), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["--live", "--output", "data/notifications.json"])

    def test_real_transport_contract_deduplicates_and_recovers_lost_state(self):
        issues = []

        def request(api, method, path, payload=None, headers=None):
            self.assertEqual(api._origin, "https://api.github.com")
            if method == "GET":
                return list(issues)
            self.assertEqual(method, "POST")
            issues.append({
                **payload, "number": 1, "state": "open",
                "html_url": "https://github.com/owner/repo/issues/1",
            })
            raise ApiError(ambiguous=True)

        environment = {"GH_TOKEN": "fixture-token"}
        row = {
            "id": "incident", "summary": "GPU failure", "explanation": "unknown",
            "scope": {"repository": "owner/repo", "source_id": "test", "job": "gpu", "date": "2026-11-17"},
            "actionable": True, "classification": "unexplained",
        }
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            JsonAPI, "request", autospec=True, side_effect=request,
        ):
            state = Path(tmp) / "state.json"
            policy, github, reconcile = channel_callbacks(
                self.config(), "owner/repo", environment,
            )
            options = dict(
                policy=policy, github=github, reconcile=reconcile,
                trusted=True, dry_run=False, baseline=False,
            )
            first = dispatch([row], state, "2026-11-17T17:00:00Z", **options)
            dispatch([row], state, "2026-11-17T18:00:00Z", **options)
            self.assertEqual(first["assessments"][0]["notification"]["status"], "sent")
            self.assertEqual(first["assessments"][0]["notification"]["github"]["external_id"], "1")
            self.assertEqual(len(issues), 1)
            self.assertIn("## What happened\n\nunknown", issues[0]["body"])
            self.assertIn("| Job | gpu |", issues[0]["body"])
            self.assertIn("| Date (UTC) | 2026-11-17 |", issues[0]["body"])
            self.assertEqual(issues[0]["title"], "repo: gpu - GPU failure")
            self.assertNotIn("Affected scope: {", issues[0]["body"])
            self.assertNotIn("private@example.test", json.dumps(first) + state.read_text())
            issues[0]["title"] = "Edited by an investigator"
            state.unlink()
            options["baseline"] = True
            restored = dispatch([row], state, "2026-11-17T19:00:00Z", **options)
            status = restored["assessments"][0]["notification"]
            self.assertEqual(status["github"]["status"], "sent")
            self.assertEqual(status["email"]["status"], "disabled")
            self.assertEqual(len(issues), 1)

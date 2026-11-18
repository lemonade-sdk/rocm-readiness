"""Evaluate dashboard incidents; delivery is opt-in and trusted-run only."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if __package__:
    from .assessments import evaluate_dataset, validate_config
    from .notification_channels import (
        ApiError, ConfigurationError, GitHubTransport, Notification,
        has_initial_routing, parse_notification_config,
    )
    from .notifications import dispatch, write_atomic
else:
    from assessments import evaluate_dataset, validate_config
    from notification_channels import (
        ApiError, ConfigurationError, GitHubTransport, Notification,
        has_initial_routing, parse_notification_config,
    )
    from notifications import dispatch, write_atomic


def trusted_run(environment, repository):
    return (
        environment.get("GITHUB_ACTIONS") == "true"
        and environment.get("GITHUB_REF") == "refs/heads/main"
        and environment.get("GITHUB_REPOSITORY") == repository
        and environment.get("GITHUB_EVENT_NAME") in
        ("workflow_dispatch", "workflow_run")
    )


class GitCheckpoint:
    """Push intent before sending; a rejected push prevents external side effects."""

    def __init__(self, dataset, output):
        self.root = Path.cwd().resolve()
        if Path(dataset).resolve() != self.root / "data":
            raise ValueError("live checkpoint requires repository data directory")
        if Path(output).resolve() != self.root / "data/notifications.json":
            raise ValueError("live checkpoint requires public notifications path")

    def git(self, *args):
        result = subprocess.run(
            ["git", *args], cwd=self.root, capture_output=True, text=True,
        )
        if result.returncode:
            raise RuntimeError(f"notification checkpoint git {args[0]} failed")
        return result.stdout.strip()

    def __call__(self):
        self.git("diff", "--cached", "--quiet")
        paths = [
            path for path in (
                "data/notification-state.json", "data/notifications.json", "data/latest.json",
            ) if (self.root / path).is_file()
        ]
        if not paths:
            return
        self.git("add", "-f", "--", *paths)
        changed = subprocess.run(
            ["git", "diff", "--cached", "--quiet"], cwd=self.root,
            capture_output=True,
        )
        if changed.returncode == 0:
            return
        if changed.returncode != 1:
            raise RuntimeError("notification checkpoint cannot inspect changes")
        self.git(
            "commit", "-qm",
            "Update dashboard incident state\n\n"
            "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
        )
        self.git("push", "origin", "HEAD:refs/heads/main")


def publish_document(dataset, output, document, repository, checkpoint=None):
    write_atomic(output, document)
    if checkpoint is None:
        return
    pointer = Path(dataset) / "latest.json"
    if pointer.exists():
        latest = json.loads(pointer.read_text(encoding="utf-8"))
        latest["notifications_url"] = (
            f"https://raw.githubusercontent.com/{repository}/main/data/notifications.json"
        )
        write_atomic(pointer, latest)
    checkpoint()


def channel_callbacks(config, repository, environment, *, labels_by_source=None):
    labels_by_source = labels_by_source or {}
    github = GitHubTransport(repository, environment.get("GH_TOKEN"))

    def notification(assessment):
        scope = assessment.get("scope", {})
        source_id = scope.get("source_id", "pipeline")
        source = scope.get("repository", source_id).rsplit("/", 1)[-1]
        job = scope.get("job") or scope.get("workflow") or scope.get("channel")
        title = f"{source}: {job} - {assessment['summary']}" if job else f"{source}: {assessment['summary']}"
        fields = (
            ("repository", "Repository"), ("workflow", "Workflow"), ("job", "Job"),
            ("channel", "Channel"), ("rocm_version", "ROCm"), ("platform", "Platform"),
            ("target", "GPU target"), ("date", "Date (UTC)"),
        )
        rows = "\n".join(
            f"| {label} | {str(scope[key]).replace('|', r'\|').replace(chr(10), ' ')} |"
            for key, label in fields if key in scope
        )
        observed_status = assessment.get("observed", {}).get("status")
        if observed_status:
            rows += f"\n| Reported result | {observed_status} |"
        return Notification(
            incident_id=assessment["id"], summary=title,
            scope=source_id, reason=assessment["explanation"],
            details="## Affected build or job\n\n| Field | Value |\n| --- | --- |\n" + rows
            + "\n\n## Evidence\n\n" + "\n".join(
                f"- [{item['label']}]({item['url']})"
                for item in assessment.get("evidence", [])
            ) + "\n\n## Follow-up\n\nReview the linked job logs and investigate the recorded result. "
            "Repeated observations reuse this issue.",
            labels=(labels_by_source[source_id],) if source_id in labels_by_source else (),
        )

    def response(result):
        status = {
            "accepted": "sent", "rejected": "failed", "ambiguous": "uncertain",
            "unavailable": "unavailable", "disabled": "disabled", "dry_run": "pending",
        }[result.status]
        value = {"status": status}
        if result.issue_url:
            value["url"] = result.issue_url
        if result.external_id:
            value["external_id"] = result.external_id
        if status in ("failed", "uncertain", "unavailable"):
            print(f"Notification channel {status}: {result.code or 'unknown'}",
                  file=sys.stderr)
        return value

    def send_github(assessment, _incident):
        message = notification(assessment)
        return response(github.deliver(
            message, config.for_channel("github", message.scope),
        ))

    policy = {"github": {
        "enabled": config.github.enabled if config.github.available else None,
        "scopes": config.github.scopes,
    }}
    def reconcile(assessment):
        source_id = assessment.get("scope", {}).get("source_id", "pipeline")
        if not config.for_channel("github", source_id).enabled:
            return None
        try:
            existing = github.lookup(assessment["id"])
        except ApiError:
            print("GitHub incident reconciliation unavailable.", file=sys.stderr)
            return None
        if (
            existing and existing["state"] == "open"
            and has_initial_routing(existing)
        ):
            return {"status": "sent", "url": existing["html_url"]}
        return None

    return policy, send_github, reconcile


def main(argv=None):
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=root / "data")
    parser.add_argument("--rules", type=Path, default=root / "alert-rules.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository", default="lemonade-sdk/rocm-readiness")
    parser.add_argument("--now", help="Fixed timezone-aware evaluation timestamp")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--checkpoint-git", action="store_true")
    parser.add_argument("--test-notification", metavar="TEST_ID",
                        help="Use only the separate test-recipient secret")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("invalid repository")
    if (args.live or args.checkpoint_git) and not trusted_run(os.environ, args.repository):
        parser.error("live publication requires a trusted main-branch Actions run")
    if args.live and not args.checkpoint_git:
        parser.error("live dispatch requires durable Git checkpoints")
    now = args.now or datetime.now(timezone.utc).isoformat()
    rules = validate_config(json.loads(args.rules.read_text(encoding="utf-8")))
    if args.test_notification:
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", args.test_notification):
            parser.error("invalid test identifier")
        assessments = [{
            "id": hashlib.sha256(("controlled-test/" + args.test_notification).encode()).hexdigest(),
            "rule_id": "controlled-test", "rule_version": 1, "evaluated_at": now,
            "actionable": True, "classification": "explained_abnormal",
            "summary": "ROCm Readiness controlled delivery test",
            "explanation": "Authorized test; no producer failure is implied.",
            "scope": {"source_id": "notification-test", "repository": args.repository},
            "observed": {"complete": True}, "expected": {}, "evidence": [],
        }]
    else:
        assessments = evaluate_dataset(args.dataset, rules, now)
    secret_name = (
        "ROCM_READINESS_TEST_NOTIFICATION_LIST" if args.test_notification
        else "ROCM_READINESS_NOTIFICATION_LIST"
    )
    sources = json.loads((root / "sources.json").read_text(encoding="utf-8"))
    known_scopes = {source["id"] for source in sources["sources"]}
    known_scopes.update({"notification-test", "pipeline"})
    try:
        config = parse_notification_config(
            os.environ.get(secret_name), known_scopes=known_scopes,
        )
    except ConfigurationError:
        print("Invalid notification configuration; delivery unavailable.", file=sys.stderr)
        config = parse_notification_config(None)
    policy, github, reconcile = channel_callbacks(
        config, args.repository, os.environ,
        labels_by_source=rules.get("incident_labels", {}),
    )
    checkpoint = GitCheckpoint(
        args.dataset,
        args.dataset / "notifications.json" if args.test_notification else args.output,
    ) if args.checkpoint_git else None
    document = dispatch(
        assessments, args.dataset / "notification-state.json", now,
        policy=policy, github=github,
        trusted=args.live, dry_run=not args.live,
        baseline=not bool(args.test_notification),
        initialize=not bool(args.test_notification),
        checkpoint=checkpoint if args.live else None,
        reconcile=reconcile,
    )
    if args.test_notification:
        write_atomic(args.output, document)
    else:
        publish_document(args.dataset, args.output, document, args.repository, checkpoint)
    print(f"Evaluated {len(assessments)} assessments; "
          + ("live delivery policy applied." if args.live else "no notifications sent."))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        print("Notification processing failed; inspect configuration, data, and checkpoint access.",
              file=sys.stderr)
        sys.exit(1)

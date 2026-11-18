"""Persist incident lifecycle and GitHub dispatch state separately from evidence."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import tempfile


STATUSES = {"pending", "sent", "failed", "disabled", "unavailable", "uncertain"}


def validate_state(state):
    if (
        not isinstance(state, dict)
        or state.get("schema_version") != 1
        or set(state) - {"schema_version", "initialized_at", "incidents", "blocked"}
        or not isinstance(state.get("incidents"), dict)
        or ("blocked" in state and type(state["blocked"]) is not bool)
    ):
        raise ValueError("invalid notification state")
    if "initialized_at" in state:
        timestamp(state["initialized_at"])
    incident_keys = {
        "first_seen_at", "last_seen_at", "lifecycle", "baseline", "github", "email",
        "recovered_at", "recurred_at",
    }
    channel_keys = {
        "status", "attempts", "last_attempt_at", "next_retry_at", "url",
        "dispatched_at",
        "external_id",
    }
    for identity, incident in state["incidents"].items():
        if (
            not isinstance(identity, str) or not identity
            or not isinstance(incident, dict) or set(incident) - incident_keys
            or incident.get("lifecycle") not in ("open", "recovered")
            or type(incident.get("baseline")) is not bool
            or any(not isinstance(value, str) for key, value in incident.items()
                   if key not in ("baseline", "github", "email"))
        ):
            raise ValueError("invalid notification incident")
        for key in ("first_seen_at", "last_seen_at", "recovered_at", "recurred_at"):
            if key in incident:
                timestamp(incident[key])
        for name in ("github", "email"):
            row = incident.get(name)
            if (
                not isinstance(row, dict) or set(row) - channel_keys
                or row.get("status") not in STATUSES
                or type(row.get("attempts")) is not int or row["attempts"] < 0
                or any(not isinstance(value, str) for key, value in row.items()
                       if key != "attempts")
            ):
                raise ValueError("invalid notification delivery state")
            for key in ("last_attempt_at", "next_retry_at", "dispatched_at"):
                if key in row:
                    timestamp(row[key])
    return state


def validate_document(document):
    if (
        not isinstance(document, dict) or document.get("schema_version") != 1
        or set(document) - {"schema_version", "generated_at", "dry_run", "assessments"}
        or not isinstance(document.get("assessments"), list)
    ):
        raise ValueError("invalid notification document")
    timestamp(document["generated_at"])
    for assessment in document["assessments"]:
        if (
            not isinstance(assessment, dict)
            or not isinstance(assessment.get("id"), str)
            or type(assessment.get("actionable")) is not bool
            or not isinstance(assessment.get("scope"), dict)
            or not isinstance(assessment.get("explanation"), str)
        ):
            raise ValueError("invalid notification assessment")
        if "notification" in assessment:
            for name in ("github", "email"):
                if assessment["notification"].get(name, {}).get("status") not in STATUSES:
                    raise ValueError("invalid public delivery state")
    return document


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("notification timestamp requires a timezone")
    return parsed


def write_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".notification-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, allow_nan=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked_state(path):
    """Local dispatchers share a lock; CI also serializes across runners."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if path.exists():
            state = json.loads(path.read_text(encoding="utf-8"))
            validate_state(state)
            if state.get("blocked"):
                raise ValueError("notification state requires operator recovery")
        else:
            state = {"schema_version": 1, "incidents": {}}
        yield state


def public_notification(incident):
    row = incident["github"]
    github = {
        key: row[key] for key in ("status", "url", "dispatched_at", "external_id")
        if key in row
    }
    status = "sent" if row["status"] == "sent" else (
        "failed" if row["status"] in ("failed", "uncertain") else "pending"
    )
    return {"github": github, "email": {"status": "disabled"}, "status": status}


def dispatch(
    assessments, state_path, now, *, github=None,
    policy=None, trusted=False, dry_run=True, baseline=True, max_attempts=5,
    checkpoint=None, reconcile=None, initialize=True,
):
    """The GitHub callable must reconcile before writing and return public status."""
    now = timestamp(now) if isinstance(now, str) else now
    if now.tzinfo is None:
        raise ValueError("notification time requires a timezone")
    policy = policy or {}
    preview = dry_run or not trusted
    result = []
    with locked_state(state_path) as saved:
        def persist():
            write_atomic(state_path, state)
            if checkpoint is not None:
                checkpoint()

        state = deepcopy(saved) if preview else saved
        first_run = not state.get("initialized_at")
        baseline_ids = {
            item.get("causal_incident_id") or item["id"]
            for item in assessments if item["actionable"] and item.get("escalation_required") is not False
        } if first_run and baseline else set()
        if not preview and initialize:
            state.setdefault("initialized_at", now.isoformat())
        for assessment in assessments:
            assessment = deepcopy(assessment)
            identity = assessment.get("causal_incident_id") or assessment["id"]
            if not isinstance(identity, str) or not identity:
                raise ValueError("assessment requires an incident identity")
            new = identity not in state["incidents"]
            incident = state["incidents"].setdefault(identity, {
                "first_seen_at": now.isoformat(),
                "lifecycle": "open",
                "baseline": identity in baseline_ids,
                "github": {"status": "pending", "attempts": 0},
                "email": {"status": "disabled", "attempts": 0},
            })
            result.append(assessment)
            incident["last_seen_at"] = now.isoformat()
            if (
                new and incident["baseline"] and not preview
                and assessment.get("escalation_required") is not False
                and reconcile is not None
                and policy.get("github", {}).get("enabled") is True
            ):
                recovered = reconcile({**assessment, "id": identity})
                if recovered is not None:
                    incident["github"].update(recovered)
            if not assessment["actionable"]:
                if (
                    not new
                    and assessment.get("classification") == "expected"
                    and assessment.get("observed", {}).get("complete") is True
                ):
                    incident["lifecycle"] = "recovered"
                    incident["recovered_at"] = now.isoformat()
                    incident["baseline"] = False
                continue
            if incident["lifecycle"] == "recovered":
                # Recurrences reuse the investigation, without another initial alert.
                incident["lifecycle"] = "open"
                incident["recurred_at"] = now.isoformat()
                if incident["github"]["status"] == "sent":
                    incident["github"]["status"] = "pending"
                    incident["github"]["attempts"] = 0
            if assessment.get("escalation_required") is False:
                # Explained abnormalities remain abnormal; only escalation is suppressed.
                continue
            row = incident["github"]
            routing = policy.get("github", {})
            enabled = routing.get("enabled")
            scopes = routing.get("scopes", [])
            if enabled is False or (
                scopes and assessment.get("scope", {}).get("source_id") not in scopes
            ):
                if row["status"] != "sent":
                    row["status"] = "disabled"
                continue
            if enabled is not True or github is None:
                if row["status"] != "sent":
                    row["status"] = "unavailable"
                continue
            if row["status"] == "sent":
                continue
            if row["status"] in ("disabled", "unavailable"):
                row["status"] = "pending"
            if preview or incident["baseline"]:
                continue
            if row.get("attempts", 0) >= max_attempts:
                row["status"] = "failed"
                continue
            if row.get("next_retry_at") and now < timestamp(row["next_retry_at"]):
                continue
            row["attempts"] = row.get("attempts", 0) + 1
            row["last_attempt_at"] = now.isoformat()
            # A crash during a send must not look like a known rejection.
            row["status"] = "uncertain"
            persist()
            try:
                response = github({**assessment, "id": identity}, incident)
            except (TimeoutError, ConnectionError, OSError):
                response = {"status": "uncertain"}
            if not isinstance(response, dict) or response.get("status") not in STATUSES:
                raise ValueError("invalid notification channel response")
            row["status"] = response["status"]
            for key in ("url", "dispatched_at", "external_id"):
                if key in response:
                    row[key] = response[key]
            if row["status"] == "sent":
                row.setdefault("dispatched_at", now.isoformat())
            elif row["status"] in ("pending", "failed"):
                row["next_retry_at"] = (
                    now + timedelta(minutes=min(60, 2 ** row["attempts"]))
                ).isoformat()
            persist()
        if not preview:
            persist()
        for assessment in result:
            identity = assessment.get("causal_incident_id") or assessment["id"]
            assessment["notification"] = public_notification(state["incidents"][identity])
    return {
        "schema_version": 1, "generated_at": now.isoformat(),
        "dry_run": preview, "assessments": result,
    }

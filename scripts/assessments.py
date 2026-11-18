"""Deterministic, offline alert policy evaluation over a published dataset.

No producer verdicts are recalculated and no network investigation is performed.
Only explicit operating policy and supplied, verified evidence explain inactivity.
"""

from datetime import datetime, time, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import re
from string import Formatter
from zoneinfo import ZoneInfo

if __package__:
    from .readiness import release_version_key, track
else:
    from readiness import release_version_key, track


SCOPE_FIELDS = (
    "repository", "source_id", "workflow", "job", "channel", "platform",
    "target", "rocm_version",
)
KINDS = {"result", "pass_rate", "missing"}
STATES = {
    "success": "pass", "passed": "pass", "failure": "fail", "failed": "fail",
    "timed_out": "fail", "action_required": "fail", "warning": "warn",
    "skipped": "skip", "cancelled": "cancelled", "canceled": "cancelled",
}
FINAL_RESULT_STATES = {"pass", "warn", "fail", "cancelled"}
RESPONSE_CLASSIFICATIONS = {
    "active": {"unexplained", "explained_abnormal"},
    "with_details": {"unexplained", "explained_abnormal"},
    "with_failed_step": {"unexplained", "explained_abnormal"},
    "recovered": {"expected"},
    "suppressed": {"expected"},
    "permitted": {"expected"},
    "dependency": {"explained_abnormal"},
    "unexplained": {"unexplained"},
}
RESPONSE_FIELDS = {"status", "matched_status", "details", "reason", "exception"}


def _validate_responses(responses, cases, optional=()):
    if not isinstance(responses, dict) or not set(cases) <= set(responses) or set(responses) - set(cases) - set(optional):
        raise ValueError("invalid result response cases")
    for case, response in responses.items():
        if (
            not isinstance(response, dict)
            or not {"classification", "summary", "explanation"} <= set(response)
            or set(response) - {"classification", "summary", "explanation", "explains_cause"}
            or ("explains_cause" in response and type(response["explains_cause"]) is not bool)
            or not isinstance(response["classification"], str)
            or response["classification"] not in RESPONSE_CLASSIFICATIONS[case]
        ):
            raise ValueError("invalid result response")
        for key in ("summary", "explanation"):
            template = response[key]
            if not isinstance(template, str) or not template.strip():
                raise ValueError("result response requires nonempty text")
            for _, field, spec, conversion in Formatter().parse(template):
                if field is not None and (
                    field not in RESPONSE_FIELDS or spec or conversion
                ):
                    raise ValueError("invalid result response placeholder")


def _validate_result_rule(rule):
    outcomes = rule.get("outcomes")
    recovery = rule.get("recovery_states")
    if (
        not isinstance(outcomes, list) or not outcomes
        or not isinstance(recovery, list) or not recovery
        or any(not isinstance(state, str) or state not in FINAL_RESULT_STATES for state in recovery)
        or len(recovery) != len(set(recovery))
        or not isinstance(rule.get("expected_status"), str) or not rule["expected_status"].strip()
    ):
        raise ValueError("invalid result policy")
    anomalies, statuses = set(), set()
    for outcome in outcomes:
        if (
            not isinstance(outcome, dict)
            or not {"anomaly", "status", "responses"} <= set(outcome)
            or set(outcome) - {"anomaly", "status", "responses", "failed_steps"}
        ):
            raise ValueError("invalid result outcome")
        anomaly, status = outcome["anomaly"], outcome["status"]
        if (
            not isinstance(anomaly, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", anomaly)
            or anomaly in anomalies
            or not isinstance(status, str) or status not in FINAL_RESULT_STATES
            or status in statuses
        ):
            raise ValueError("invalid or duplicate result outcome")
        anomalies.add(anomaly)
        statuses.add(status)
        _validate_responses(
            outcome["responses"], ("active", "with_details", "recovered", "suppressed"),
            optional=("with_failed_step",),
        )
        if "failed_steps" in outcome and (
            not isinstance(outcome["failed_steps"], list) or not outcome["failed_steps"]
            or any(not isinstance(step, str) or not step.strip() for step in outcome["failed_steps"])
            or "with_failed_step" not in outcome["responses"]
        ):
            raise ValueError("invalid failed-step response match")
    skip = rule.get("skip")
    if (
        not isinstance(skip, dict)
        or set(skip) != {"status", "anomaly", "dependency_anomaly", "expected_status", "responses"}
        or skip["status"] != "skip"
        or not isinstance(skip["anomaly"], str)
        or not re.fullmatch(r"[a-z][a-z0-9_]*", skip["anomaly"])
        or skip["anomaly"] in anomalies
        or not isinstance(skip["dependency_anomaly"], str)
        or skip["dependency_anomaly"] not in anomalies
        or not isinstance(skip["expected_status"], str) or not skip["expected_status"].strip()
    ):
        raise ValueError("invalid skip policy")
    _validate_responses(skip["responses"], ("permitted", "dependency", "unexplained", "recovered"))


def _response(response, context):
    return (
        response["classification"],
        response["summary"].format_map(context),
        response["explanation"].format_map(context),
    )


def _time(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if not isinstance(parsed, datetime) or parsed.tzinfo is None:
        raise ValueError("assessment timestamps must include a timezone")
    return parsed.astimezone(timezone.utc)


def _digest(value):
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False,
    ).encode()).hexdigest()


def _number(value, name, minimum=0):
    if type(value) not in (int, float) or not math.isfinite(value) or value < minimum:
        raise ValueError(f"invalid {name}")


def validate_config(config):
    """Validate the separate alert policy document, without modifying it."""
    if not isinstance(config, dict) or type(config.get("schema_version")) is not int or config["schema_version"] != 1:
        raise ValueError("invalid alert schema_version")
    if not isinstance(config.get("rules"), list):
        raise ValueError("alert rules must be a list")
    labels = config.get("incident_labels", {})
    if not isinstance(labels, dict) or any(
        not isinstance(source, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", source)
        or not isinstance(label, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_. -]{0,49}", label)
        or label != label.strip()
        for source, label in labels.items()
    ):
        raise ValueError("invalid incident label mapping")
    tracks = config.get("current_nightly_tracks", {})
    if not isinstance(tracks, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not v
        for k, v in tracks.items()
    ):
        raise ValueError("invalid current_nightly_tracks")
    for version in tracks.values():
        if version != "latest":
            track(version)
    seen = set()
    for rule in config["rules"]:
        if not isinstance(rule, dict):
            raise ValueError("invalid alert rule")
        rid = rule.get("id")
        if not isinstance(rid, str) or not rid or rid in seen:
            raise ValueError("invalid or duplicate alert rule id")
        seen.add(rid)
        if type(rule.get("version")) is not int or rule["version"] < 1:
            raise ValueError("invalid alert rule version")
        if rule.get("kind") not in KINDS or type(rule.get("enabled", True)) is not bool:
            raise ValueError("invalid alert kind or enabled")
        if rule["kind"] == "result":
            _validate_result_rule(rule)
        match = rule.get("match", {})
        if not isinstance(match, dict) or any(
            k not in SCOPE_FIELDS or not isinstance(v, (str, list))
            or (isinstance(v, list) and (not v or any(not isinstance(i, str) for i in v)))
            for k, v in match.items()
        ):
            raise ValueError("invalid alert match")
        for name in ("max_age_hours", "grace_hours", "window_days"):
            if name in rule:
                _number(rule[name], name, 0 if name == "grace_hours" else 0.000001)
        if rule["kind"] == "pass_rate":
            _number(rule.get("threshold_percent"), "threshold_percent")
            if rule["threshold_percent"] > 100:
                raise ValueError("threshold_percent exceeds 100")
            if type(rule.get("minimum_samples")) is not int or rule["minimum_samples"] < 1:
                raise ValueError("invalid minimum_samples")
            _number(rule.get("window_days"), "window_days", 0.000001)
        if "schedule" in rule:
            schedule = rule["schedule"]
            if not isinstance(schedule, dict):
                raise ValueError("invalid schedule")
            try:
                ZoneInfo(schedule["timezone"])
                parsed = time.fromisoformat(schedule["time"])
                if parsed.tzinfo or parsed.second or parsed.microsecond:
                    raise ValueError("schedule time must be local HH:MM")
                days = schedule["weekdays"]
                if not isinstance(days, list) or not days or any(
                    type(d) is not int or d not in range(7) for d in days
                ):
                    raise ValueError("invalid schedule weekdays")
            except (KeyError, TypeError) as error:
                raise ValueError("invalid schedule") from error
        if "event_driven" in rule and type(rule["event_driven"]) is not bool:
            raise ValueError("invalid event_driven")
        if rule["kind"] == "missing" and (
            int("schedule" in rule) + int("max_age_hours" in rule)
            + int(rule.get("event_driven", False)) != 1
        ):
            raise ValueError("missing rule requires exactly one explicit expectation")
        if "older_track_response" in rule:
            response = rule["older_track_response"]
            if (
                rule["kind"] != "missing" or not isinstance(response, dict)
                or set(response) != {"summary", "explanation"}
            ):
                raise ValueError("invalid older-track response")
            for template in response.values():
                if not isinstance(template, str) or not template.strip():
                    raise ValueError("older-track response requires text")
                for _, field, spec, conversion in Formatter().parse(template):
                    if field is not None and (
                        field not in {"track", "current_track"} or spec or conversion
                    ):
                        raise ValueError("invalid older-track response placeholder")
        if not isinstance(rule.get("exceptions", []), list):
            raise ValueError("exceptions must be a list")
        for exception in rule.get("exceptions", []):
            if not isinstance(exception, dict) or not isinstance(exception.get("reason"), str):
                raise ValueError("exception requires reason")
            match = exception.get("match")
            if not isinstance(match, dict) or not match or any(
                k not in SCOPE_FIELDS or not isinstance(v, (str, list))
                or isinstance(v, list) and (not v or any(not isinstance(i, str) for i in v))
                for k, v in match.items()
            ):
                raise ValueError("invalid exception match")
            for key in ("until", "from"):
                if key in exception:
                    _time(exception[key])
    return config


def _matches(scope, match):
    return all(scope.get(k) in (v if isinstance(v, list) else [v]) for k, v in match.items())


def _evidence(row):
    links = []
    for field, label in (
        ("url", "Job"), ("run_url", "Run"), ("report_url", "Qualification report"),
        ("source_url", "Source"), ("workflow_url", "Run-revision workflow"),
    ):
        url = row.get(field)
        if isinstance(url, str) and url.startswith("https://"):
            link = {"label": label, "url": url}
            if link not in links:
                links.append(link)
    return links


def _assessment(rule, now, scope, anomaly, actionable, classification,
                summary, explanation, observed, expected, evidence=(), occurrence=None):
    identity = {k: scope[k] for k in SCOPE_FIELDS if k in scope}
    result = {
        "id": _digest({"scope": identity, "anomaly": anomaly}),
        "anomaly": anomaly,
        "rule_id": rule["id"], "rule_version": rule["version"],
        "evaluated_at": now.isoformat(), "actionable": actionable,
        "classification": classification, "summary": summary,
        "explanation": explanation, "scope": dict(scope),
        "observed": observed, "expected": expected,
        "evidence": list(evidence),
    }
    if occurrence is not None:
        result["observation_id"] = _digest(occurrence)
        row = occurrence.get("row", {})
        result["provenance"] = {
            key: value for key, value in {
                "repository": scope.get("repository"),
                "run_id": occurrence.get("run_id"),
                "attempt": occurrence.get("attempt"),
                "job_id": row.get("job_id"),
                "revision": row.get("sha") or row.get("head_sha"),
                "workflow": scope.get("workflow"),
                "job": scope.get("job"),
            }.items() if value is not None
        }
        for key in ("run_id", "attempt", "job_id"):
            value = result["provenance"].get(key)
            if not isinstance(value, (str, int)) or isinstance(value, bool) or not str(value).isdigit() or int(value) < 1:
                result["provenance"].pop(key, None)
    return result


def _load(root, relative):
    if not isinstance(relative, str):
        raise ValueError("dataset reference must be a path")
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("dataset reference escapes dataset directory")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _scope(row, source):
    values = {
        "repository": source.get("repository"), "source_id": source.get("id"),
        "workflow": row.get("workflow"), "job": row.get("job"),
        "channel": row.get("channel", source.get("channel")),
        "platform": row.get("os"), "target": row.get("gfx_target", row.get("target")),
        "rocm_version": row.get("rocm_version"),
    }
    return {k: v for k, v in values.items() if v is not None}


def _live_sync(root, index):
    candidates = []
    if index.get("collection_status") == "complete" and index.get("generated_at"):
        candidates.append({"status": "success", "attempted_at": index["generated_at"],
                           "errors": []})
    if isinstance(index.get("sync"), dict):
        candidates.append(index["sync"])
    for name in ("sync.json", "latest.json"):
        if (root / name).exists():
            document = _load(root, name)
            if name == "latest.json" and isinstance(document, dict) and "sync" not in document:
                continue
            if not isinstance(document, dict) or not isinstance(document.get("sync"), dict):
                raise ValueError(f"invalid {name} synchronization metadata")
            candidates.append(document["sync"])
    for candidate in candidates:
        if candidate.get("status") not in ("success", "failed"):
            raise ValueError("invalid synchronization status")
        _time(candidate.get("attempted_at"))
    if not candidates:
        return None
    latest = max(candidates, key=lambda s: (_time(s["attempted_at"]), s["status"] == "failed"))
    return {"status": latest["status"], "attempted_at": latest["attempted_at"]}


def _read_dataset(dataset_dir, now):
    root = Path(dataset_dir).resolve()
    index = _load(root, "index.json")
    sync = _live_sync(root, index)
    index["_assessment_sync"] = sync
    sources = {s["id"]: s for s in index.get("sources", [])}
    observations, scopes = [], {}
    complete = index.get("collection_status") == "complete"
    for version in index.get("versions", []):
        overview = _load(root, version["overview"])
        for item in overview.get("history", []):
            path = item["path"] if isinstance(item, dict) else item
            for row in _load(root, path).get("builds", []):
                source = sources.get(row["source_id"], {"id": row["source_id"]})
                at = _time(row["generated_at"])
                if at > now:
                    continue
                scope = _scope(row, source)
                ok = complete and source.get("status") in ("fresh", "stale")
                key = _digest(scope)
                scopes[key] = {"scope": scope, "complete": ok, "source": source,
                               "collected_at": _time(index["generated_at"])}
                observations.append({
                    "scope": scope, "at": at, "row": row, "complete": ok,
                    "state": "cancelled" if row.get("build_result") in ("cancelled", "canceled") else row["overall"],
                    "attempt": row.get("run_attempt", 0),
                    "run_id": row.get("run_id") or row.get("run_url") or row.get("build_id"),
                })
    upstream = index.get("upstream", {})
    if upstream.get("overview"):
        overview = _load(root, upstream["overview"])
        for project in overview.get("projects", []):
            source = {"id": project["id"] + "-upstream", "repository": project["repository"]}
            jobs = {j["id"]: j for j in project.get("jobs", [])}
            coverage = project.get("coverage", {})
            ok = complete and coverage.get("complete") is True
            for job in jobs.values():
                scope = _scope({**job, "job": job["id"]}, source)
                scopes[_digest(scope)] = {
                    "scope": scope, "complete": ok, "source": coverage,
                    "collected_at": _time(coverage.get("collected_at", index["generated_at"])),
                }
            for item in project.get("files", []):
                for row in _load(root, item["path"]).get("runs", []):
                    if row["job"] not in jobs:
                        continue
                    at = _time(row["created_at"])
                    if at > now:
                        continue
                    job = jobs[row["job"]]
                    scope = _scope({**job, "job": job["id"]}, source)
                    observations.append({
                        "scope": scope, "at": at, "row": row, "complete": ok,
                        "state": STATES.get(row.get("conclusion"), row.get("state", "unknown")),
                        "attempt": row.get("attempt", 0), "run_id": row["run_id"],
                    })
    return index, observations, scopes


def _latest(rows):
    return max(rows, key=lambda r: (r["at"], r["attempt"], _digest(r["row"])))


def _deduplicate(rows):
    groups = {}
    for row in rows:
        key = (_digest(row["scope"]), str(row["run_id"]))
        prior = groups.get(key)
        if prior is None or (row["attempt"], _digest(row["row"])) > (prior["attempt"], _digest(prior["row"])):
            groups[key] = row
    return list(groups.values())


def _exception(rule, scope, now, config):
    if scope.get("channel") == "nightly":
        current = config.get("current_nightly_tracks", {}).get(scope.get("source_id"))
        if current and scope.get("rocm_version") and (
            release_version_key({"version": scope["rocm_version"]})
            < release_version_key({"version": current})
        ):
            return "Accepted current-nightly-only policy; retained older track is not monitored."
    for item in rule.get("exceptions", []):
        if (_matches(scope, item["match"])
                and ("from" not in item or now >= _time(item["from"]))
                and ("until" not in item or now < _time(item["until"]))):
            return "Explicit policy exception: " + item["reason"]
    return None


def _resolve_nightly_tracks(config, index, observations, now):
    repositories = {source["id"]: source.get("repository") for source in index.get("sources", [])}
    resolved = {}
    for source_id, selection in config.get("current_nightly_tracks", {}).items():
        if selection != "latest":
            resolved[source_id] = selection
            continue
        candidates = [
            item["rocm_version"] for item in index.get("versions", [])
            if repositories.get(source_id)
            and item.get("release", {}).get("repository") == repositories[source_id]
            and item["release"].get("channel") == "nightly"
            and _time(item["release"]["published_at"]) <= now
        ]
        if not candidates:
            candidates = [
                row["scope"]["rocm_version"] for row in observations
                if row["scope"].get("source_id") == source_id
                and row["scope"].get("channel") == "nightly"
                and row["scope"].get("rocm_version")
            ]
        if candidates:
            for candidate in candidates:
                track(candidate)
            resolved[source_id] = max(candidates, key=lambda version: release_version_key({"version": version}))
    return resolved


def _result(rule, now, scope, rows, complete, exception, all_rows):
    if not rows:
        return []
    latest = _latest(rows)
    row, state = latest["row"], latest["state"]
    scope = {**scope, "date": latest["at"].date().isoformat()}
    occurrence = {"run_id": latest["run_id"], "attempt": latest["attempt"], "row": row}
    evidence = _evidence(row)
    observed = {"status": state, "complete": complete}
    if "overall" in row:
        observed["qualification_overall"] = row["overall"]
    details = row.get("blocking_tests") or row.get("blocked_by") or row.get("failed_step")
    if isinstance(details, list):
        details = "; ".join(str(detail) for detail in details)
    context = {
        "status": state, "matched_status": "", "details": details or "",
        "exception": exception or "", "reason": "",
    }
    results = []
    for outcome in rule["outcomes"]:
        anomaly, matched = outcome["anomaly"], outcome["status"]
        context["matched_status"] = matched
        if exception:
            active, case = False, "suppressed"
        elif state == matched or (state in rule["recovery_states"] and complete):
            active = state == matched
            case = "with_details" if active and details else "active" if active else "recovered"
            if (
                active and row.get("failed_step") and "with_failed_step" in outcome["responses"]
                and ("failed_steps" not in outcome or row["failed_step"] in outcome["failed_steps"])
            ):
                case = "with_failed_step"
                context["details"] = row["failed_step"]
        else:
            continue
        results.append(_assessment(
            rule, now, scope, anomaly, active,
            *_response(outcome["responses"][case], context),
            observed, {"status": rule["expected_status"]}, evidence, occurrence,
        ))
        results[-1]["explanation_basis"] = (
            "failed_step" if case in ("with_details", "with_failed_step")
            and not (row.get("blocking_tests") or row.get("blocked_by")) else
            "details" if case == "with_details" else case
        )
        if outcome["responses"][case].get("explains_cause") is True:
            results[-1]["explanation_verified"] = True
    skip = rule["skip"]
    if state == skip["status"] and not exception:
        verified = row.get("verified_skip", {})
        permitted = (
            verified.get("permitted") is True and verified.get("verified") is True
            and bool(verified.get("reason")) and bool(verified.get("workflow_url"))
            and bool(verified.get("event_url"))
        )
        cause = None
        # Dependencies must be verified at the run revision, not inferred from names.
        dependencies = row.get("verified_dependencies", {})
        prerequisite = next(
            outcome for outcome in rule["outcomes"]
            if outcome["anomaly"] == skip["dependency_anomaly"]
        )
        if dependencies.get("workflow_url") and dependencies.get("verified") is True:
            for other in all_rows:
                if (other["run_id"] == latest["run_id"] and other["attempt"] == latest["attempt"]
                        and other["scope"].get("repository") == scope.get("repository")
                        and other["scope"].get("workflow") == scope.get("workflow")
                        and other["scope"].get("job") in dependencies.get("jobs", [])
                        and other["state"] == prerequisite["status"]):
                    cause = other
                    break
        skip_evidence = evidence[:]
        if permitted:
            skip_evidence.extend([
                {"label": "Verified workflow gate", "url": verified["workflow_url"]},
                {"label": "Evaluated event", "url": verified["event_url"]},
            ])
        context["matched_status"] = skip["status"]
        context["reason"] = verified["reason"] if permitted else ""
        case = "permitted" if permitted else "dependency" if cause else "unexplained"
        result = _assessment(
            rule, now, scope, skip["anomaly"], not permitted and not cause,
            *_response(skip["responses"][case], context),
            {"status": state, "complete": complete}, {"status": skip["expected_status"]},
            skip_evidence, occurrence,
        )
        result["explanation_basis"] = case
        if cause:
            result["causal_incident_id"] = _digest({
                "scope": cause["scope"], "anomaly": prerequisite["anomaly"],
            })
            result["evidence"].extend(_evidence(cause["row"]))
            result["evidence"].append({"label": "Verified dependency", "url": dependencies["workflow_url"]})
        results.append(result)
    elif complete and state in rule["recovery_states"] and not exception:
        context["matched_status"] = skip["status"]
        results.append(_assessment(
            rule, now, scope, skip["anomaly"], False,
            *_response(skip["responses"]["recovered"], context),
            {"status": state, "complete": True},
            {"status": skip["expected_status"]}, evidence, occurrence,
        ))
    return results


def _pass_rate(rule, now, scope, rows, complete, exception):
    start = now - timedelta(days=rule["window_days"])
    rows = [r for r in rows if start <= r["at"] <= now]
    decided = [r for r in rows if r["state"] in ("pass", "fail")]
    passed = sum(r["state"] == "pass" for r in decided)
    total = len(decided)
    rate = 100 * passed / total if total else None
    known = complete and total >= rule["minimum_samples"]
    active = known and rate < rule["threshold_percent"] and not exception
    if rows:
        scope = {**scope, "date": _latest(rows)["at"].date().isoformat()}
    observed = {"passed": passed, "decided": total, "pass_rate_percent": rate,
                "window_start": start.isoformat(), "complete": complete}
    explanation = (
        exception if exception else
        "Collection coverage is incomplete; the observed ratio cannot establish a full-window rate." if not complete else
        "No decided results; pass rate is unknown, not zero." if not total else
        "Decided sample is below the configured minimum." if not known else
        f"{passed}/{total} decided results passed in the configured window. "
        "Cancelled, skipped, running and unknown results are excluded."
    )
    result = _assessment(
        rule, now, scope, "pass_rate", active,
        "expected" if exception or known and not active else "explained_abnormal" if active else "unexplained",
        "Pass rate below threshold" if active else "Pass rate" if known else "Pass rate unknown",
        explanation, observed,
        {"threshold_percent": rule["threshold_percent"], "minimum_samples": rule["minimum_samples"],
         "window_days": rule["window_days"]},
        [e for r in sorted(rows, key=lambda r: (r["at"], _digest(r["row"])), reverse=True)[:3]
         for e in _evidence(r["row"])],
        {"observed": observed, "runs": sorted((str(r["run_id"]), r["attempt"]) for r in rows)},
    )
    result["explanation_basis"] = "configured"
    return result


def _due(rule, now, rows):
    grace = timedelta(hours=rule.get("grace_hours", 0))
    if "schedule" in rule:
        schedule = rule["schedule"]
        zone = ZoneInfo(schedule["timezone"])
        local = now.astimezone(zone)
        hour = time.fromisoformat(schedule["time"])
        for offset in range(8):
            day = local.date() - timedelta(days=offset)
            due = datetime.combine(day, hour, zone).astimezone(timezone.utc)
            if day.weekday() in schedule["weekdays"] and due <= now:
                return due, due + grace
    if rule.get("event_driven"):
        events = [
            r["row"]["eligible_event"] for r in rows
            if isinstance(r["row"].get("eligible_event"), dict)
            and r["row"]["eligible_event"].get("verified") is True
            and r["row"]["eligible_event"].get("eligible") is True
            and r["row"]["eligible_event"].get("url")
            and _time(r["row"]["eligible_event"]["at"]) <= now
        ]
        if events:
            due = max(_time(e["at"]) for e in events)
            return due, due + grace
    if "max_age_hours" in rule and rows:
        last = _latest(rows)["at"]
        return last, last + timedelta(hours=rule["max_age_hours"]) + grace
    return None, None


def _missing(rule, now, scope, rows, complete, exception, collected_at):
    due, deadline = _due(rule, now, rows)
    latest = _latest(rows) if rows else None
    met = bool(latest and due and latest["at"] >= due)
    if "max_age_hours" in rule and "schedule" not in rule and not rule.get("event_driven"):
        met = bool(deadline and now <= deadline)
    coverage_current = deadline is not None and collected_at >= deadline
    known = complete and deadline is not None and (coverage_current or met)
    active = known and now > deadline and not met and not exception
    if due:
        scope = {**scope, "date": due.date().isoformat()}
    explanation = (
        exception if exception else
        "Collection coverage is incomplete; absence cannot prove that the producer missed work." if not complete else
        "No verified eligible event or configured due time is available; no daily schedule is inferred." if deadline is None else
        "Latest evidence satisfies the configured expectation." if met else
        "Configured deadline and grace have not elapsed." if now <= deadline else
        "Collection predates the deadline; producer absence after that deadline is not established." if not coverage_current else
        "No evidence satisfies the explicit policy after its deadline and grace; producer cause is unresolved."
    )
    return _assessment(
        rule, now, scope, "missing_evidence", active,
        "unexplained" if active or not known and not exception else "expected",
        "Missing producer evidence" if active else "Producer evidence expectation",
        explanation,
        {"latest_at": latest["at"].isoformat() if latest else None,
         "complete": complete and (coverage_current or met),
         "collected_at": collected_at.isoformat()},
        {"due_at": due.isoformat() if due else None,
         "deadline": deadline.isoformat() if deadline else None},
        _evidence(latest["row"]) if latest else (),
        {"due_at": due.isoformat() if due else None, "latest": latest["run_id"] if latest else None},
    )


def evaluate_dataset(dataset_dir, config, now):
    """Return public assessments; performs no writes, network requests or delivery.

    False assessments only prove recovery when observed.complete is true (or an
    explicit exception applies). Missing/unknown assessments never imply recovery.
    """
    validate_config(config)
    now = _time(now)
    index, observations, scopes = _read_dataset(dataset_dir, now)
    observations = _deduplicate(observations)
    config = {**config, "current_nightly_tracks": _resolve_nightly_tracks(config, index, observations, now)}
    generated = _time(index["generated_at"]) if index.get("generated_at") else None
    sync = index["_assessment_sync"]
    sync_failed = bool(sync and sync["status"] == "failed")
    sync_future = bool(sync and _time(sync["attempted_at"]) > now)
    usable_snapshot = bool(generated and generated <= now and not sync_failed and not sync_future)
    for entry in scopes.values():
        entry["complete"] = entry["complete"] and usable_snapshot
    # A removed or renamed qualification matrix target is not a new incident.
    # Retain targets in the newest run per source/track/platform, not archive scopes.
    cohorts = {}
    for row in observations:
        if "overall" in row["row"]:
            key = tuple(row["scope"].get(k) for k in
                        ("repository", "source_id", "channel", "rocm_version", "platform"))
            cohorts.setdefault(key, []).append(row)
    current_builds = set()
    for rows in cohorts.values():
        latest = _latest(rows)
        current_builds.update(
            _digest(row["scope"]) for row in rows
            if row["run_id"] == latest["run_id"]
        )
    build_scopes = {_digest(row["scope"]) for row in observations if "overall" in row["row"]}
    scopes = {k: v for k, v in scopes.items() if k not in build_scopes or k in current_builds}
    groups = {}
    for row in observations:
        groups.setdefault(_digest(row["scope"]), []).append(row)
    assessments = []
    for rule in config["rules"]:
        if not rule.get("enabled", True):
            continue
        retained_scopes = set()
        for key, entry in sorted(scopes.items()):
            scope = entry["scope"]
            if not _matches(scope, rule.get("match", {})):
                continue
            rows = groups.get(key, [])
            exception = _exception(rule, scope, now, config)
            complete = entry["complete"]
            if rule["kind"] == "result":
                # Include same-run prerequisites in investigation, not newest selection.
                result = _result(rule, now, scope, rows, complete, exception, observations)
                assessments.extend(result)
            elif rule["kind"] == "pass_rate":
                since = entry["source"].get("since")
                full_window = not since or _time(since) <= now - timedelta(days=rule["window_days"])
                assessments.append(_pass_rate(
                    rule, now, scope, rows, complete and full_window, exception,
                ))
            elif rule["kind"] == "missing":
                current = config.get("current_nightly_tracks", {}).get(scope.get("source_id"))
                response = rule.get("older_track_response")
                if (
                    response and current and scope.get("channel") == "nightly"
                    and scope.get("rocm_version")
                    and release_version_key({"version": scope["rocm_version"]})
                    < release_version_key({"version": current})
                ):
                    policy_scope = {
                        key: value for key, value in scope.items()
                        if key != "target" or "target" in rule.get("match", {})
                    }
                    policy_id = _digest(policy_scope)
                    if policy_id not in retained_scopes:
                        retained_scopes.add(policy_id)
                        context = {"track": scope["rocm_version"], "current_track": current}
                        assessment = _assessment(
                            rule, now, policy_scope, "retained_nightly", False, "expected",
                            response["summary"].format_map(context),
                            response["explanation"].format_map(context),
                            {"status": "unmonitored", "complete": False},
                            {"current_track": current},
                        )
                        assessment["applies_to"] = "missing_observation"
                        assessments.append(assessment)
                    continue
                assessments.append(_missing(
                    rule, now, scope, rows, complete, exception, entry["collected_at"],
                ))
    return sorted(assessments, key=lambda a: (a["id"], a["rule_id"]))

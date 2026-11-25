"""Derive the cell findings the dashboard displays from collection metadata.

The dashboard renders these records verbatim. Every decision about which cells a
collection failure or producer check explains is made here, in CI.
"""

from datetime import datetime, timezone
import hashlib
import json
import re

KINDS = ("collection_failed", "upstream_unchanged")
_SCOPE_KEYS = {"date", "source_id"}
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_RAW = re.compile(
    r"https://raw\.githubusercontent\.com/([^/]+/[^/]+)/([a-f0-9]{40})/(.+)"
)
_RUN = re.compile(
    r"^run=([1-9]\d{0,19}) engine=([A-Za-z0-9._-]+): "
    r"benchmark job evidence access failed(?:\s|$)"
)
_HTTPS = re.compile(r"https://[^\s]+")


def _when(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _date(value):
    return _when(value).date().isoformat()


def _blob(url):
    match = _RAW.fullmatch(url or "")
    if not match:
        return None
    return f"https://github.com/{match[1]}/blob/{match[2]}/{match[3]}"


def _affected(source_id, sources):
    """Return the calendar sources whose empty cells a failed source explains."""
    source = sources.get(source_id)
    if source is None:
        return [None]
    if source.get("adapter") == "lemonade-leaderboard-v1":
        affected = sorted(
            sid
            for sid, item in sources.items()
            if item.get("adapter") == "qualification-v1"
            and item.get("engine") == source.get("engine")
        )
        return affected or [None]
    return [source_id]


def _failure_text(error, sources):
    if error is None:
        return "the dashboard update could not be published.", []
    source = sources.get(error["source_id"], {})
    reason = error["reason"].strip()
    benchmark = (
        source.get("adapter") == "lemonade-leaderboard-v1"
        and error["field"] == "package_evidence"
    )
    evidence = []
    if benchmark:
        leaderboard = _blob(source.get("url"))
        if leaderboard:
            evidence.append({"label": "Lemonade benchmark leaderboard", "url": leaderboard})
    if benchmark and "benchmark job evidence access failed" in reason:
        status = re.search(r"\bHTTP ([45]\d{2})\b", reason)
        run = _RUN.match(reason)
        if run and source.get("repository"):
            evidence.append(
                {
                    "label": "Benchmark run",
                    "url": f"https://github.com/{source['repository']}/actions/runs/{run[1]}",
                }
            )
        suffix = f" (HTTP {status[1]})" if status else ""
        return (
            "Lemonade's published benchmark links to a GitHub run the dashboard "
            f"couldn't read{suffix}.",
            evidence,
        )
    plain = (
        0 < len(reason) <= 160
        and not _HTTPS.search(reason)
        and "\n" not in reason
        and not re.search(r"(?:^|\s)(?:run|engine)=", reason)
    )
    if not plain:
        return f"{error['source_id']} could not be refreshed.", evidence
    return (reason if reason[-1] in ".!?" else f"{reason}."), evidence


def _identifier(kind, scopes, finding):
    digest = hashlib.sha256(
        json.dumps([kind, scopes, finding], sort_keys=True).encode()
    ).hexdigest()[:16]
    return f"{kind}:{digest}"


def collection_findings(sync, sources):
    """Explain empty calendar cells using retained attempts and producer checks.

    ``sources`` is the index source catalog (id, engine, adapter, url, ...).
    """
    catalog = {source["id"]: source for source in sources or []}
    current = {key: sync[key] for key in ("attempted_at", "status", "errors")}
    attempts = sorted(
        {
            json.dumps(item, sort_keys=True): item
            for item in [*sync.get("attempts", []), current]
        }.values(),
        key=lambda item: _when(item["attempted_at"]),
    )
    last_success = max(
        (_when(item["attempted_at"]) for item in attempts if item["status"] == "success"),
        default=None,
    )
    last_failure = {}
    for attempt in attempts:
        if attempt["status"] == "failed":
            last_failure[_date(attempt["attempted_at"])] = _when(attempt["attempted_at"])
    groups = {}
    for attempt in attempts:
        if attempt["status"] != "failed":
            continue
        day = _date(attempt["attempted_at"])
        # Only the unbroken run of failures ending at the current attempt is an outage.
        live = current["status"] == "failed" and (
            last_success is None or _when(attempt["attempted_at"]) > last_success
        )
        for error in attempt["errors"] or [None]:
            text, evidence = _failure_text(error, catalog)
            for source_id in _affected(error and error["source_id"], catalog):
                group = groups.setdefault((day, source_id, text), {"evidence": [], "live": False})
                group["live"] = group["live"] or live
                for item in evidence:
                    if item not in group["evidence"]:
                        group["evidence"].append(item)
    merged = {}
    for (day, source_id, text), group in groups.items():
        prefix = "No new dashboard data" if group["live"] else "Collection attempt failed"
        finding = f"{prefix}: {text}"
        recovered = any(
            item["status"] == "success"
            and _date(item["attempted_at"]) == day
            and _when(item["attempted_at"]) > last_failure[day]
            for item in attempts
        )
        scope = {"date": day} if source_id is None else {"date": day, "source_id": source_id}
        key = (finding, recovered, json.dumps(group["evidence"], sort_keys=True))
        entry = merged.setdefault(
            key,
            {
                "kind": "collection_failed",
                "applies_to": "missing_observation",
                "scopes": [],
                "finding": finding,
                "evidence": group["evidence"],
            },
        )
        if recovered:
            entry["status"] = "A later collection attempt on this date succeeded."
        entry["scopes"].append(scope)
    findings = list(merged.values())
    for source in sources or []:
        check = source.get("last_check")
        if not check or check.get("status") != "unchanged":
            continue
        sha = check.get("upstream_sha")
        finding = (
            "Upstream checked; no change since the last build, so no new build "
            "was produced."
            if not sha
            else f"Upstream checked at {sha[:7]}; no change since the last build, "
            "so no new build was produced."
        )
        findings.append(
            {
                "kind": "upstream_unchanged",
                "applies_to": "missing_observation",
                "scopes": [{"date": _date(check["checked_at"]), "source_id": source["id"]}],
                "finding": finding,
                "evidence": (
                    [{"label": "Check run", "url": check["run_url"]}]
                    if check.get("run_url")
                    else []
                ),
            }
        )
    for item in findings:
        item["scopes"].sort(key=lambda scope: (scope["date"], scope.get("source_id", "")))
        item["id"] = _identifier(item["kind"], item["scopes"], item["finding"])
    findings.sort(key=lambda item: (item["scopes"][0]["date"], item["id"]))
    return findings


def finding_errors(findings):
    """Return JSON-pointer problems for a published findings array."""
    if not isinstance(findings, list):
        return [("", "expected findings array")]
    problems, ids = [], set()
    for pos, item in enumerate(findings):
        where = f"/{pos}"
        if not isinstance(item, dict) or not {
            "id", "kind", "applies_to", "scopes", "finding", "evidence"
        } <= set(item) <= {
            "id", "kind", "applies_to", "scopes", "finding", "status", "evidence"
        }:
            problems.append((where, "invalid finding fields"))
            continue
        if not isinstance(item["id"], str) or item["id"] in ids:
            problems.append((where + "/id", "finding IDs must be unique strings"))
        ids.add(item["id"])
        if item["kind"] not in KINDS:
            problems.append((where + "/kind", "unknown finding kind"))
        if item["applies_to"] != "missing_observation":
            problems.append((where + "/applies_to", "unknown finding target"))
        if not isinstance(item["finding"], str) or not item["finding"]:
            problems.append((where + "/finding", "expected finding text"))
        if "status" in item and (not isinstance(item["status"], str) or not item["status"]):
            problems.append((where + "/status", "expected status text"))
        scopes = item["scopes"]
        if not isinstance(scopes, list) or not scopes or not all(
            isinstance(scope, dict)
            and "date" in scope
            and set(scope) <= _SCOPE_KEYS
            and all(isinstance(value, str) for value in scope.values())
            and _DATE.fullmatch(scope["date"])
            for scope in scopes
        ):
            problems.append((where + "/scopes", "expected dated cell scopes"))
        evidence = item["evidence"]
        if not isinstance(evidence, list) or not all(
            isinstance(link, dict)
            and set(link) == {"label", "url"}
            and isinstance(link["label"], str)
            and isinstance(link["url"], str)
            and link["url"].startswith("https://")
            for link in evidence
        ):
            problems.append((where + "/evidence", "expected labeled https evidence"))
    return problems


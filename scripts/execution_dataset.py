"""UI execution projection; benchmark completion is separate from accuracy/speed."""

from collections import defaultdict
from datetime import datetime
import json
import math

if __package__:
    from .attribution import validate_measurement_package
else:
    from attribution import validate_measurement_package

SCOPE = (
    "source_id",
    "engine",
    "channel",
    "backend",
    "rocm_version",
    "engine_version",
    "package_url",
    "package_os",
    "system_id",
    "scenario",
    "context_size",
    "backend_args",
)


def _parsed_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _version_identity(value):
    parts = [int(part) for part in value.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def summarize(attempts):
    groups = defaultdict(list)
    for row in attempts:
        groups[tuple(row.get(k) for k in SCOPE)].append(row)
    summaries = []
    for key, rows in sorted(groups.items(), key=lambda item: str(item[0])):
        if any(row["execution_status"] == "unknown" for row in rows):
            continue
        models = defaultdict(list)
        for row in rows:
            models[row["model"]].append(row["execution_status"])
        statuses = [
            (
                "failed"
                if "failed" in values
                else "partial"
                if "partial" in values
                else "passed"
            )
            for values in models.values()
        ]
        summaries.append(
            {
                **dict(zip(SCOPE, key)),
                "hardware": rows[0]["hardware"],
                "passed": statuses.count("passed"),
                "partial": statuses.count("partial"),
                "failed": statuses.count("failed"),
                "total": len(models),
                "latest_at": max(
                    (row["measured_at"] for row in rows), key=_parsed_time
                ),
                "models": sorted(models),
            }
        )
    return summaries


def validate_execution_file(data, version):
    """Check counts independently from the writer's selection/count helper."""

    def require(ok, reason):
        if not ok:
            raise ValueError(reason)

    require(
        data.get("schema_version") == 1 and data.get("rocm_version") == version,
        "invalid execution version",
    )
    rows = data.get("attempts")
    require(isinstance(rows, list), "invalid execution attempts")
    groups = {}
    identities = set()
    for row in rows:
        require(row.get("rocm_version") == version, "execution version mismatch")
        package = validate_measurement_package(row)
        if row.get("producer_rocm_version") is not None:
            require(
                _version_identity(row["producer_rocm_version"])
                == _version_identity(version),
                "producer ROCm version conflicts with package",
            )
        require(
            package["rocm_version"] == version
            and package["version"] == row["engine_version"]
            and package["repository"] == row["engine_repository"]
            and package["os"] == row["package_os"],
            "execution package mismatch",
        )
        require(
            row["hardware"].get("os") == row["package_os"],
            "execution hardware/package OS mismatch",
        )
        require(
            row.get("execution_status") in ("passed", "partial", "failed", "unknown"),
            "invalid execution status",
        )
        date = datetime.fromisoformat(row["measured_at"].replace("Z", "+00:00"))
        require(date.tzinfo is not None, "execution timestamp timezone missing")
        key = tuple(row.get(k) for k in SCOPE)
        identity = (
            key,
            row["model"],
            row.get("quant"),
            json.dumps(row["checkpoints"], sort_keys=True),
        )
        require(identity not in identities, "duplicate execution model/variant")
        identities.add(identity)
        groups.setdefault(key, []).append(row)
    summaries = data.get("summaries")
    require(isinstance(summaries, list), "invalid execution summaries")
    seen = set()
    for summary in summaries:
        key = tuple(summary.get(k) for k in SCOPE)
        require(key in groups and key not in seen, "invalid summary scope")
        seen.add(key)
        values = groups[key]
        require(
            all(r["execution_status"] != "unknown" for r in values),
            "unsupported summary",
        )
        models = {}
        for row in values:
            models.setdefault(row["model"], set()).add(row["execution_status"])
        passed = sum(status == {"passed"} for status in models.values())
        failed = sum("failed" in status for status in models.values())
        partial = len(models) - passed - failed
        require(
            all(
                type(summary.get(k)) is int and summary[k] == expected
                for k, expected in [
                    ("passed", passed),
                    ("failed", failed),
                    ("partial", partial),
                    ("total", len(models)),
                ]
            ),
            "execution summary count mismatch",
        )
        require(
            summary.get("models") == sorted(models), "execution summary model mismatch"
        )
        require(
            summary.get("hardware") == values[0]["hardware"],
            "execution summary hardware mismatch",
        )
        require(
            summary.get("latest_at")
            == max((r["measured_at"] for r in values), key=_parsed_time),
            "execution summary date mismatch",
        )
    expected_scopes = {
        k
        for k, values in groups.items()
        if all(r["execution_status"] != "unknown" for r in values)
    }
    require(seen == expected_scopes, "missing execution summary")
    return rows


def validate_execution_provenance(attempts, evidence):
    """Check the UI projection against the original detailed producer documents."""
    import hashlib

    def require(ok, reason):
        if not ok:
            raise ValueError(reason)

    sources = {s["source_id"]: s for s in evidence["sources"]}
    for row in attempts:
        source = sources[row["source_id"]]
        raw = source["snapshots"][row["source_url"]]
        digest = hashlib.sha256(
            json.dumps(
                raw,
                sort_keys=True,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        require(digest == row["source_json_sha256"], "raw execution checksum mismatch")
        node = raw
        for part in row["source_pointer"].split("/")[1:]:
            key = part.replace("~1", "/").replace("~0", "~")
            node = node[int(key)] if isinstance(node, list) else node[key]
        parts = row["source_pointer"].split("/")
        model = raw["models"][int(parts[2])] if "models" in raw else raw
        backend = model["results"][int(parts[4] if "models" in raw else parts[2])]
        require(
            raw["fork_id"] == row["fork_id"]
            and raw["fork_repo"] == row["engine_repository"]
            and raw["fork_version"] == row["engine_version"]
            and str(raw["run_id"]) == str(row["run_id"])
            and raw["run_url"] == row["run_url"],
            "raw execution package/run identity mismatch",
        )
        require(
            model["model"] == row["model"]
            and model.get("timestamp", raw.get("timestamp")) == row["measured_at"]
            and model.get("checkpoints") == row["checkpoints"],
            "raw execution model identity mismatch",
        )
        hardware = {
            k: v
            for k, v in raw["hardware"].items()
            if k not in ("backends", "lemonade_version")
        }
        require(hardware == row["hardware"], "raw execution hardware mismatch")
        hardware_digest = hashlib.sha256(
            json.dumps(
                hardware,
                sort_keys=True,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        require(
            row["system_id"] == "hardware-" + hardware_digest,
            "raw execution system identity mismatch",
        )
        require(
            node["name"] == row["scenario"]
            and backend["ctx_size"] == row["context_size"]
            and backend.get("backend_args") == row["backend_args"],
            "raw execution workload mismatch",
        )
        require(
            node.get("failed_runs") == row["failed_runs"]
            and node.get("all_runs_failed") == row["all_runs_failed"],
            "raw execution outcome mismatch",
        )
        failures = node.get("failed_runs")
        successful_stats = [
            isinstance(node.get(field), dict)
            and type(node[field].get("mean")) in (int, float)
            and math.isfinite(node[field]["mean"])
            and node[field]["mean"] >= 0
            for field in ("tps", "duration_ms", "ttft_ms")
        ]
        require(
            not (node.get("all_runs_failed") is True and any(successful_stats)),
            "contradictory execution statistics",
        )
        known = (
            type(failures) is int
            and failures >= 0
            and type(model.get("config", {}).get("measurement_runs")) is int
            and model["config"]["measurement_runs"] > 0
            and all(successful_stats)
        )
        status = (
            "failed"
            if node.get("all_runs_failed") is True
            else "passed"
            if known and failures == 0
            else "partial"
            if known and failures > 0
            else "unknown"
        )
        require(row["execution_status"] == status, "raw execution status mismatch")
        require(
            row["measurement_runs"] == model.get("config", {}).get("measurement_runs")
            and row["warmup_runs"] == model.get("config", {}).get("warmup_runs"),
            "raw execution run configuration mismatch",
        )
        inventory = source["inventory"]
        require(
            len(inventory["files"]) == inventory["file_count"],
            "execution inventory count mismatch",
        )
        paths = {f["path"]: f for f in inventory["files"]}
        prefix = f"https://raw.githubusercontent.com/"
        require(row["source_url"].startswith(prefix), "invalid raw execution URL")
        url_parts = row["source_url"][len(prefix) :].split("/")
        require(
            url_parts[2] == inventory["commit"], "execution inventory revision mismatch"
        )
        path = "/".join(url_parts[3:])
        require(
            path in paths
            and paths[path]["blob_sha"] == row["source_blob_sha"]
            and paths[path]["json_sha256"] == row["source_json_sha256"],
            "execution inventory provenance mismatch",
        )


def validate_execution_completeness(attempts, evidence, packages, version):
    """Reconstruct latest raw attempts independently, including metricless failures."""
    import hashlib

    if __package__:
        from .attribution import validate_evidence
    else:
        from attribution import validate_evidence

    def require(ok, reason):
        if not ok:
            raise ValueError(reason)

    def stamp(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def key(
        sid, fork, model, checkpoints, quant, scenario, context, args, hardware, rocm
    ):
        return (
            sid,
            fork,
            model,
            json.dumps(checkpoints, sort_keys=True),
            quant,
            scenario,
            context,
            args,
            json.dumps(hardware, sort_keys=True),
            rocm,
        )

    proofs = [(p, validate_evidence(p)) for p in packages["packages"]]
    expected = {}
    for source in evidence["sources"]:
        inventory = source["inventory"]
        prefix_paths = {f["path"] for f in inventory["files"]}
        actual_paths = {"/".join(url.split("/")[6:]) for url in source["snapshots"]}
        require(prefix_paths == actual_paths, "execution raw inventory is incomplete")
        for url, raw in source["snapshots"].items():
            physical = {
                k: v
                for k, v in raw["hardware"].items()
                if k not in ("backends", "lemonade_version")
            }
            models = raw.get("models", [raw])
            for mi, model in enumerate(models):
                when = model.get("timestamp", raw.get("timestamp"))
                matches = [
                    (p, identity)
                    for p, identity in proofs
                    if p["run_id"] == str(raw["run_id"])
                    and p["fork_id"] == raw["fork_id"]
                    and p["engine_repository"] == raw["fork_repo"]
                    and p["engine_version"] == raw["fork_version"]
                    and (
                        when in p["measurement_times"]
                        if p.get("scope") == "all_available_attempts"
                        else stamp(p["started_at"])
                        <= stamp(when)
                        <= stamp(p["completed_at"])
                    )
                ]
                require(
                    len(matches) == 1, "raw execution lacks unique package attribution"
                )
                rocm = matches[0][1]["rocm_version"]
                for bi, backend in enumerate(model["results"]):
                    if (
                        backend.get("backend") != "rocm"
                        or backend.get("recipe") != "llamacpp"
                    ):
                        continue
                    for si, scenario in enumerate(backend["scenarios"]):
                        group = key(
                            source["source_id"],
                            raw["fork_id"],
                            model["model"],
                            model.get("checkpoints"),
                            model.get("quant"),
                            scenario["name"],
                            backend["ctx_size"],
                            backend.get("backend_args"),
                            physical,
                            rocm,
                        )
                        pointer = (
                            f"/models/{mi}" if "models" in raw else ""
                        ) + f"/results/{bi}/scenarios/{si}"
                        record = (stamp(when), url, pointer)
                        prior = expected.get(group)
                        if (
                            prior is None
                            or record[0] > prior[0]
                            or record[0] == prior[0]
                            and record[1:] < prior[1:]
                        ):
                            expected[group] = record
    if version is None:
        return {k[-1] for k in expected}
    wanted = {k: value[1:] for k, value in expected.items() if k[-1] == version}
    actual = {
        key(
            r["source_id"],
            r["fork_id"],
            r["model"],
            r["checkpoints"],
            r["quant"],
            r["scenario"],
            r["context_size"],
            r["backend_args"],
            r["hardware"],
            r["rocm_version"],
        ): (r["source_url"], r["source_pointer"])
        for r in attempts
    }
    require(actual == wanted, "execution latest inventory is incomplete or stale")

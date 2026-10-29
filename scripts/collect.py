"""Collect immutable producer snapshots into the static dashboard dataset."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

if __package__:
    from .attribution import attribute_stable, resolve_package
    from .conformance import validate_dataset
    from .dataset import SYSTEM_FIELDS, _load_previous, write_dataset
    from .validation import PipelineValidationError
    from .sync import load_last_success, publish_sync
else:
    from attribution import attribute_stable, resolve_package
    from conformance import validate_dataset
    from dataset import SYSTEM_FIELDS, _load_previous, write_dataset
    from validation import PipelineValidationError
    from sync import load_last_success, publish_sync

ADAPTERS = {"qualification-v1", "lemonade-leaderboard-v1"}
METRICS = (
    "tps_mean",
    "tps_p95",
    "tg_tps",
    "ttft_ms_mean",
    "ttft_ms_best",
    "pp_tps",
    "vram_peak_gb",
)
ACCURACY = (
    "accuracy",
    "accuracy_passed",
    "accuracy_total",
    "accuracy_deviations",
    "accuracy_pass",
)


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include timezone")
    return parsed


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(value):
    return (
        isinstance(value, str)
        and bool(value)
        and not value.startswith("/")
        and all(part not in ("", ".", "..") for part in value.split("/"))
        and not any(c in value for c in ("\\", ":", "?", "#", "%"))
    )


def validate_config(config):
    require(config.get("schema_version") == 1, "unsupported sources schema_version")
    engines = config["engines"]
    engine_ids = [e["id"] for e in engines]
    require(len(engine_ids) == len(set(engine_ids)), "duplicate engine id")
    seen = set()
    for source in config["sources"]:
        sid = source["id"]
        require(
            re.fullmatch(r"[a-z0-9][a-z0-9-]*", sid) is not None, "invalid source id"
        )
        require(sid not in seen, "duplicate source id")
        seen.add(sid)
        require(source["engine"] in engine_ids, "unknown engine")
        require(source["adapter"] in ADAPTERS, "unknown adapter")
        require(
            source.get("channel") in ("stable", "nightly", "from-record", "from-fork"),
            "invalid channel",
        )
        require(
            source.get("availability", "available") in ("available", "awaiting_data"),
            "invalid availability",
        )
        if source.get("availability") == "awaiting_data":
            continue
        require(
            re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source["repository"])
            is not None,
            "invalid repository",
        )
        require(isinstance(source["ref"], str) and source["ref"], "missing ref")
        require(safe_path(source["path"]), "invalid source path")
        require(
            isinstance(source["stale_after_hours"], (int, float))
            and source["stale_after_hours"] > 0,
            "invalid freshness threshold",
        )
        if source["adapter"] == "lemonade-leaderboard-v1":
            require(source.get("forks"), "missing fork mapping")
            if "include_forks" in source:
                selection = source["include_forks"]
                require(
                    isinstance(selection, list)
                    and bool(selection)
                    and all(
                        isinstance(fork, str) and fork in source["forks"]
                        for fork in selection
                    )
                    and len(set(selection)) == len(selection),
                    "invalid fork selection",
                )
            for fork in source["forks"].values():
                require(fork["engine"] in engine_ids, "unknown fork engine")
                require(
                    fork["channel"]
                    in ("stable", "nightly", "reference", "experimental"),
                    "invalid fork channel",
                )


def _check(
    source, record, field, condition, reason="missing or invalid required value"
):
    if not condition:
        raise PipelineValidationError(source["id"], record, field, reason)


def normalize_qualification(source, data, url):
    _check(source, "", "document", isinstance(data, dict), "expected object")
    _check(
        source,
        "",
        "schema_version",
        data.get("schema_version") == 1,
        "unsupported schema version",
    )
    _check(source, "", "builds", isinstance(data.get("builds"), list), "expected array")
    rows, seen = [], set()
    for index, row in enumerate(data["builds"]):
        location = f"/builds/{index}"
        _check(source, location, "record", isinstance(row, dict), "expected object")
        for field in ("build_id", "generated_at", "rocm_version", "run_url", "tag"):
            _check(
                source,
                location,
                field,
                isinstance(row.get(field), str) and bool(row[field]),
            )
        _check(
            source,
            location,
            "build_id",
            row["build_id"] not in seen,
            "duplicate build_id",
        )
        seen.add(row["build_id"])
        try:
            timestamp(row["generated_at"])
        except (ValueError, TypeError) as error:
            raise PipelineValidationError(
                source["id"], location, "generated_at", "invalid timestamp"
            ) from error
        _check(
            source,
            location,
            "run_attempt",
            type(row.get("run_attempt")) is int and row["run_attempt"] >= 0,
        )
        _check(source, location, "qualified", type(row.get("qualified")) is bool)
        _check(
            source, location, "overall", row.get("overall") in ("pass", "warn", "fail")
        )
        _check(source, location, "tests", isinstance(row.get("tests"), dict))
        for name in ("passed", "failed", "total"):
            value = row["tests"].get(name)
            _check(
                source,
                location,
                f"tests/{name}",
                type(value) is int and value >= 0,
                "missing or invalid test count",
            )
        for name, value in row["tests"].items():
            _check(
                source,
                location,
                f"tests/{pointer(name)}",
                type(value) is int and value >= 0,
                "invalid test count",
            )
        for field in ("version_qualified", "hardware_validated"):
            _check(
                source,
                location,
                field,
                row.get(field) is None or type(row[field]) is bool,
            )
        _check(
            source,
            location,
            "rocm_version",
            re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", row["rocm_version"]) is not None,
        )
        for field in ("artifact", "gfx_target"):
            _check(
                source,
                location,
                field,
                row.get(field) is None or isinstance(row[field], str),
                "invalid optional value",
            )
        for field in ("blocked_by", "blocking_tests"):
            value = row.get(field)
            _check(
                source,
                location,
                field,
                value is None
                or isinstance(value, list)
                and all(isinstance(item, str) for item in value),
                "invalid list of strings",
            )
        gfx = row.get("gfx")
        _check(
            source,
            location,
            "gfx",
            gfx is None or isinstance(gfx, dict),
            "invalid gfx metadata",
        )
        if gfx is not None:
            for field in ("requested", "present"):
                value = gfx.get(field)
                _check(
                    source,
                    location,
                    f"gfx/{field}",
                    value is None or (type(value) is int and value >= 0),
                    "invalid gfx count",
                )
            value = gfx.get("missing")
            _check(
                source,
                location,
                "gfx/missing",
                value is None
                or isinstance(value, list)
                and all(isinstance(item, str) for item in value),
                "invalid gfx targets",
            )
        _check(source, location, "results", isinstance(row.get("results"), dict))
        for name, value in row["results"].items():
            _check(
                source,
                location,
                f"results/{pointer(name)}",
                value in ("pass", "fail", "warn", "skip", "missing"),
                "invalid test result",
            )
        report = row.get("report_url")
        _check(
            source,
            location,
            "report_url",
            safe_path(report) and report.startswith("reports/"),
        )
        channel = (
            row.get("channel")
            if source["channel"] == "from-record"
            else source["channel"]
        )
        _check(source, location, "channel", channel in ("stable", "nightly"))
        system_os = row.get("os") or source.get("os")
        _check(source, location, "os", isinstance(system_os, str))
        system_os = {"ubuntu": "linux", "win": "windows"}.get(system_os, system_os)
        _check(source, location, "os", system_os in ("linux", "windows", "macos"))
        rows.append(
            {
                **row,
                "source_id": source["id"],
                "engine": source["engine"],
                "channel": channel,
                "os": system_os,
                "hardware_validated": row.get("hardware_validated"),
                "report_url": urljoin(url, report),
                "source_pointer": location,
            }
        )
    return rows


def pointer(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def normalize_performance(source, data):
    _check(source, "", "document", isinstance(data, dict), "expected object")
    _check(
        source,
        "",
        "by_model_scenario",
        isinstance(data.get("by_model_scenario"), dict),
        "expected object",
    )
    _check(
        source, "", "history", isinstance(data.get("history"), dict), "expected object"
    )
    _check(
        source, "", "systems", isinstance(data.get("systems"), list), "expected array"
    )
    system_ids = set()
    for index, system in enumerate(data["systems"]):
        location = f"/systems/{index}"
        _check(
            source,
            location,
            "system",
            isinstance(system, dict),
            "invalid system metadata",
        )
        _check(
            source,
            location,
            "id",
            isinstance(system.get("id"), str) and bool(system["id"]),
            "invalid system id",
        )
        _check(
            source,
            location,
            "id",
            system["id"] not in system_ids,
            "duplicate system id",
        )
        system_ids.add(system["id"])
        for field in ("cpu", "gpu", "os"):
            _check(
                source,
                location,
                field,
                system.get(field) is None or isinstance(system[field], str),
                "invalid system metadata",
            )
        gpu_full = system.get("gpu_full")
        _check(
            source,
            location,
            "gpu_full",
            gpu_full is None or isinstance(gpu_full, (str, list)),
            "invalid GPU metadata",
        )
        if isinstance(gpu_full, list):
            for gpu_index, gpu in enumerate(gpu_full):
                field = f"gpu_full/{gpu_index}"
                _check(
                    source,
                    location,
                    field,
                    isinstance(gpu, dict),
                    "expected GPU object",
                )
                _check(
                    source,
                    location,
                    f"{field}/name",
                    isinstance(gpu.get("name"), str) and bool(gpu["name"]),
                    "invalid GPU name",
                )
                _check(
                    source,
                    location,
                    f"{field}/type",
                    gpu.get("type") is None or isinstance(gpu["type"], str),
                    "invalid GPU type",
                )
                _check(
                    source,
                    location,
                    f"{field}/integrated",
                    gpu.get("integrated") is None or type(gpu["integrated"]) is bool,
                    "invalid GPU integrated flag",
                )
                vram = gpu.get("vram_gb")
                _check(
                    source,
                    location,
                    f"{field}/vram_gb",
                    vram is None
                    or (
                        type(vram) in (int, float) and math.isfinite(vram) and vram >= 0
                    ),
                    "invalid GPU memory",
                )
        for field in ("ram_gb", "vram_gb"):
            value = system.get(field)
            _check(
                source,
                location,
                field,
                value is None
                or (
                    type(value) in (int, float) and math.isfinite(value) and value >= 0
                ),
                "invalid system metadata",
            )
    rows = []

    def append(row, fork_id, model, scenario, kind, location):
        _check(source, location, "record", isinstance(row, dict), "expected object")
        if kind == "latest":
            fork_id = row.get("fork_id")
        _check(source, location, "fork_id", isinstance(fork_id, str) and bool(fork_id))
        if "include_forks" in source and fork_id not in source["include_forks"]:
            return
        if kind == "latest":
            for field in ("fork_id", "model", "scenario"):
                _check(
                    source,
                    location,
                    field,
                    isinstance(row.get(field), str) and bool(row[field]),
                )
            fork_id, model, scenario = row["fork_id"], row["model"], row["scenario"]
        _check(
            source,
            location,
            "fork_id",
            isinstance(fork_id, str) and fork_id in source["forks"],
            "unknown fork",
        )
        fork = source["forks"][fork_id]
        for field, expected in (
            ("fork_repo", fork["repository"]),
            ("backend", fork["backend"]),
        ):
            _check(
                source,
                location,
                field,
                field not in row or row[field] == expected,
                "producer identity differs from configured fork",
            )
        for field, value in (("model", model), ("scenario", scenario)):
            _check(source, location, field, isinstance(value, str) and bool(value))
        for field, minimum in (("ctx_size", 1), ("input_tokens", 0)):
            value = row.get(field)
            _check(
                source,
                location,
                field,
                value is None or (type(value) is int and value >= minimum),
                "invalid optional value",
            )
        _check(
            source,
            location,
            "quant",
            row.get("quant") is None or isinstance(row["quant"], str),
            "invalid optional value",
        )
        version_field = "fork_version" if kind == "latest" else "version"
        _check(
            source,
            location,
            version_field,
            isinstance(row.get(version_field), str) and bool(row[version_field]),
        )
        run_id = row.get("run_id")
        _check(
            source,
            location,
            "run_id",
            (isinstance(run_id, str) and re.fullmatch(r"[0-9]+", run_id) is not None)
            or (type(run_id) is int and run_id >= 0),
        )
        _check(
            source,
            location,
            "hw_id",
            row.get("hw_id") is None
            or (isinstance(row["hw_id"], str) and row["hw_id"] in system_ids),
            "unknown system id",
        )
        for field in ("timestamp", "run_url"):
            _check(
                source,
                location,
                field,
                isinstance(row.get(field), str) and bool(row[field]),
            )
        run = re.fullmatch(
            r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/runs/([0-9]+)",
            row["run_url"],
        )
        _check(
            source,
            location,
            "run_url",
            run is not None
            and run[2] == str(run_id)
            and (not source.get("repository") or run[1] == source["repository"]),
            "run URL does not match source and run_id",
        )
        try:
            timestamp(row["timestamp"])
        except (ValueError, TypeError) as error:
            raise PipelineValidationError(
                source["id"], location, "timestamp", "invalid timestamp"
            ) from error
        for metric in METRICS:
            value = row.get(metric)
            valid = type(value) in (int, float) and math.isfinite(value) and value >= 0
            _check(
                source,
                location,
                metric,
                (
                    valid
                    if metric in ("tps_mean", "ttft_ms_mean")
                    else value is None or valid
                ),
            )
        for field in ACCURACY:
            value = row.get(field)
            if value is None:
                continue
            valid = (
                type(value) is bool
                if field == "accuracy_pass"
                else (
                    type(value) in (int, float)
                    and math.isfinite(value)
                    and 0 <= value <= 1
                    if field == "accuracy"
                    else type(value) is int and value >= 0
                )
            )
            _check(source, location, field, valid, "invalid accuracy value")
        rows.append(
            {
                "source_id": source["id"],
                "source_pointer": location,
                "kind": kind,
                "engine": fork["engine"],
                "channel": fork["channel"],
                "backend": fork["backend"],
                "fork_id": fork_id,
                "engine_repository": fork["repository"],
                "engine_version": row[version_field],
                "model": model,
                "scenario": scenario,
                "quant": row.get("quant"),
                "system_id": row.get("hw_id"),
                "context_size": row.get("ctx_size"),
                "input_tokens": row.get("input_tokens"),
                "measured_at": row["timestamp"],
                "run_id": run_id,
                "run_url": row["run_url"],
                "lemonade_version": row.get("lemonade_version"),
                "metrics": {key: row.get(key) for key in METRICS},
                "rocm_version": None,
                "qualification_build_id": None,
                "accuracy_verdict": None,
                "producer_accuracy": {key: row.get(key) for key in ACCURACY},
            }
        )

    for group, entries in data["by_model_scenario"].items():
        location = f"/by_model_scenario/{pointer(group)}"
        _check(source, location, "entries", isinstance(entries, list), "expected array")
        for index, row in enumerate(entries):
            append(row, None, None, None, "latest", f"{location}/{index}")
    for model, scenarios in data["history"].items():
        location = f"/history/{pointer(model)}"
        _check(
            source,
            location,
            "scenarios",
            isinstance(scenarios, dict),
            "expected object",
        )
        for scenario, forks in scenarios.items():
            location_scenario = f"{location}/{pointer(scenario)}"
            _check(
                source,
                location_scenario,
                "forks",
                isinstance(forks, dict),
                "expected object",
            )
            for fork_id, entries in forks.items():
                if "include_forks" in source and fork_id not in source["include_forks"]:
                    continue
                location_fork = f"{location_scenario}/{pointer(fork_id)}"
                _check(
                    source,
                    location_fork,
                    "entries",
                    isinstance(entries, list),
                    "expected array",
                )
                for index, row in enumerate(entries):
                    append(
                        row,
                        fork_id,
                        model,
                        scenario,
                        "history",
                        f"{location_fork}/{index}",
                    )
    return rows


def fetch_json(url):
    headers = {"User-Agent": "rocm-readiness-collector", "Accept": "application/json"}
    token = os.environ.get("GH_TOKEN")
    if url.startswith("https://api.github.com/") and token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers=headers), timeout=45) as response:
                raw = response.read(32 * 1024 * 1024 + 1)
            require(len(raw) <= 32 * 1024 * 1024, "source exceeds 32 MiB")
            return json.loads(raw)
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code not in (
                429,
                500,
                502,
                503,
                504,
            ):
                raise
            if attempt == 2:
                raise
            time.sleep(2**attempt)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def collect(
    config,
    destination,
    fetch=fetch_json,
    now=None,
    previous_data=None,
    package_evidence=None,
    resolve_packages=None,
):
    validate_config(config)
    last_success = load_last_success(destination, previous_data)
    now = now or datetime.now(timezone.utc).isoformat()
    clock = timestamp(now)
    output = {
        "schema_version": 1,
        "generated_at": now,
        "collection_status": "complete",
        "reference_model": config.get("reference_model"),
        "engines": config["engines"],
        "sources": [],
        "builds": [],
        "measurements": [],
        "systems": [],
        "errors": [],
    }
    commits = {}
    for source in config["sources"]:
        sid = source["id"]
        state = {
            "id": sid,
            "engine": source["engine"],
            "channel": source["channel"],
            "adapter": source["adapter"],
            "status": "awaiting_data",
            "record_count": 0,
        }
        if "include_forks" in source:
            state["include_forks"] = source["include_forks"]
        output["sources"].append(state)
        if source.get("availability") == "awaiting_data":
            state.update(
                {
                    key: source[key]
                    for key in ("repository", "ref", "path")
                    if key in source
                }
            )
            print(f"{sid}: awaiting_data (not fetched)", flush=True)
            continue
        fetch_url = None
        try:
            repo, ref = source["repository"], source["ref"]
            key = (repo, ref)
            if key not in commits:
                fetch_url = (
                    f'https://api.github.com/repos/{repo}/commits/{quote(ref, safe="")}'
                )
                commits[key] = fetch(fetch_url)["sha"]
            commit = commits[key]
            require(
                re.fullmatch(r"[a-f0-9]{40}", commit) is not None,
                "invalid source commit",
            )
            url = f'https://raw.githubusercontent.com/{repo}/{commit}/{quote(source["path"], safe="/")}'
            state.update(repository=repo, ref=ref, commit=commit, url=url)
            print(f"{sid}: fetching {url}", flush=True)
            fetch_url = url
            data = fetch(url)
            fetch_url = None
            if source["adapter"] == "qualification-v1":
                rows = normalize_qualification(source, data, url)
                target, date_key = "builds", "generated_at"
            else:
                rows = normalize_performance(source, data)
                systems = [
                    {**system, "source_id": sid, "source_pointer": f"/systems/{index}"}
                    for index, system in enumerate(data["systems"])
                ]
                target, date_key = "measurements", "measured_at"
            snapshot = f"raw/{sid}.json"
            state.update(
                snapshot=snapshot, sha256=write_json(destination / snapshot, data)
            )
            latest = max((timestamp(row[date_key]) for row in rows), default=None)
            age = (clock - latest).total_seconds() / 3600 if latest else None
            require(age is None or age >= 0, "observation timestamp is in the future")
            state.update(
                status=(
                    "empty"
                    if not rows
                    else "stale" if age > source["stale_after_hours"] else "fresh"
                ),
                latest_observation_at=latest.isoformat() if latest else None,
                age_hours=round(age, 2) if age is not None else None,
                record_count=len(rows),
                destination=(
                    "rocm/*/history/*.json"
                    if target == "builds"
                    else "selected model measurements"
                ),
                stale_after_hours=source["stale_after_hours"],
            )
            output[target].extend(rows)
            if target == "measurements":
                for row in rows:
                    row["source_url"] = url
                output["systems"].extend(systems)
            print(
                f'{sid}: validated {len(rows)} records -> {state["destination"]} ({state["status"]})',
                flush=True,
            )
        except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
            if isinstance(error, PipelineValidationError):
                diagnostic = error.diagnostic
            elif fetch_url:
                diagnostic = PipelineValidationError(
                    sid, "", "fetch", f"{fetch_url}: {type(error).__name__}: {error}"
                ).diagnostic
            else:
                diagnostic = PipelineValidationError(
                    sid, "", "source", f"{type(error).__name__}: {error}"
                ).diagnostic
            output["errors"].append(diagnostic)
            state.update(status="error", error=str(error), diagnostic=diagnostic)
            output["collection_status"] = "degraded"
            print(f"{sid}: ERROR {diagnostic}", file=sys.stderr, flush=True)
    write_json(destination / "errors.json", {"errors": output["errors"]})
    evidence = list(package_evidence or [])
    previous_measurements = []
    system_matches = None
    if previous_data is not None:
        _, prior_measurements, prior_systems = _load_previous(previous_data)
        current_systems = {
            (system["source_id"], system["id"]): system for system in output["systems"]
        }
        previous_measurements = prior_measurements.values()

        def system_matches(row, previous):
            current = current_systems.get((row["source_id"], row["system_id"]))
            old = prior_systems.get(
                (previous["rocm_version"], previous["source_id"], previous["system_id"])
            )
            return (
                current is not None
                and old is not None
                and all(
                    current.get(field) == old.get(field)
                    for field in SYSTEM_FIELDS
                    if field not in ("id", "source_pointer")
                )
            )

    attribute_stable(
        output, evidence, resolve_packages, previous_measurements, system_matches
    )
    for source in output["sources"]:
        if source["adapter"] == "lemonade-leaderboard-v1" and source["status"] not in (
            "error",
            "awaiting_data",
        ):
            source["destination"] = "rocm/*/performance.json"
    write_json(
        destination / "provenance/packages.json",
        {
            "schema_version": 1,
            "packages": output["package_evidence"],
        },
    )
    output["dataset"] = write_dataset(
        output,
        destination,
        previous_data=previous_data,
        publish_index=False,
        source_configs={source["id"]: source for source in config["sources"]},
    )
    write_json(destination / "errors.json", {"errors": output["errors"]})
    if output["errors"]:
        output["dataset"]["errors"] = output["errors"]
    output["dataset"]["sync"] = publish_sync(
        destination,
        now,
        "success" if output["collection_status"] == "complete" else "failed",
        last_success,
        output["errors"],
    )
    write_json(destination / "index.json", output["dataset"])
    if output["collection_status"] == "complete":
        validate_dataset(destination, config, check_live_pointer=False)
    print(
        f"Dataset: index.json, {len(output['dataset']['versions'])} ROCm version overviews",
        flush=True,
    )
    stable = output["dataset"]["stable_performance"]
    print(
        f'Stable model observations: {stable["assigned_count"]} assigned, '
        f'{stable["awaiting_evidence_count"]} awaiting evidence',
        flush=True,
    )
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=Path("sources.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    parser.add_argument(
        "--package-evidence",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "provenance/llamacpp-stable-packages.json",
        help="Verified package evidence used for stable performance backfill",
    )
    parser.add_argument(
        "--previous-data",
        type=Path,
        help="Previous complete dataset to carry build history forward",
    )
    args = parser.parse_args()
    attempted_at = datetime.now(timezone.utc).isoformat()
    last_success = None
    errors_initialized = False
    try:
        last_success = load_last_success(args.output_dir, args.previous_data)
        write_json(args.output_dir / "errors.json", {"errors": []})
        errors_initialized = True
        evidence = json.loads(args.package_evidence.read_text(encoding="utf-8"))
        if (
            not isinstance(evidence, dict)
            or evidence.get("schema_version") != 1
            or not isinstance(evidence.get("packages"), list)
        ):
            raise PipelineValidationError(
                "package-evidence",
                str(args.package_evidence),
                "package_evidence",
                "invalid package evidence",
            )
        output = collect(
            json.loads(args.sources.read_text(encoding="utf-8")),
            args.output_dir,
            now=attempted_at,
            previous_data=args.previous_data,
            package_evidence=evidence["packages"],
            resolve_packages=resolve_package,
        )
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        print(f"Collection error: {error}", file=sys.stderr)
        diagnostic = (
            error.diagnostic
            if isinstance(error, PipelineValidationError)
            else PipelineValidationError(
                "pipeline", "", "pipeline", f"{type(error).__name__}: {error}"
            ).diagnostic
        )
        try:
            errors = []
            try:
                prior_errors = json.loads(
                    (args.output_dir / "errors.json").read_text(encoding="utf-8")
                )
                if errors_initialized and isinstance(prior_errors.get("errors"), list):
                    errors = prior_errors["errors"]
            except (OSError, ValueError, AttributeError):
                pass
            errors.append(diagnostic)
            write_json(args.output_dir / "errors.json", {"errors": errors})
            sync = publish_sync(
                args.output_dir, attempted_at, "failed", last_success, errors
            )
            write_json(
                args.output_dir / "index.json",
                {
                    "schema_version": 2,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "collection_status": "degraded",
                    "error": str(error),
                    "errors": errors,
                    "sync": sync,
                    "versions": [],
                },
            )
        except OSError as write_error:
            print(f"Could not write diagnostic index: {write_error}", file=sys.stderr)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(
                os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8"
            ) as handle:
                handle.write(f"## Data collection failed\n\n{error}\n")
        return 1
    lines = [
        "## Data collection",
        "",
        f'Status: {output["collection_status"]}',
        "",
        "| Source | Status | Records | Destination |",
        "| --- | --- | ---: | --- |",
    ]
    lines.extend(
        f'| {s["id"]} | {s["status"]} | {s["record_count"]} | {s.get("destination", "—")} |'
        for s in output["sources"]
    )
    if output["errors"]:
        lines.extend(["", "### Errors", *[f"- {error}" for error in output["errors"]]])
    summary = "\n".join(lines) + "\n"
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(summary)
    return 0 if output["collection_status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())

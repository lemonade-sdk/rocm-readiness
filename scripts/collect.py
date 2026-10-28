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
    from .dataset import write_dataset
else:
    from attribution import attribute_stable, resolve_package
    from dataset import write_dataset

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
            for fork in source["forks"].values():
                require(fork["engine"] in engine_ids, "unknown fork engine")
                require(
                    fork["channel"]
                    in ("stable", "nightly", "reference", "experimental"),
                    "invalid fork channel",
                )


def normalize_qualification(source, data, url):
    require(data.get("schema_version") == 1, "unsupported qualification schema_version")
    require(isinstance(data.get("builds"), list), "builds must be an array")
    rows = []
    seen = set()
    for row in data["builds"]:
        for field in ("build_id", "generated_at", "rocm_version", "run_url", "tag"):
            require(isinstance(row.get(field), str) and row[field], f"missing {field}")
        require(row["build_id"] not in seen, "duplicate build_id")
        seen.add(row["build_id"])
        timestamp(row["generated_at"])
        require(
            type(row.get("run_attempt")) is int and row["run_attempt"] >= 0,
            "run_attempt must be a nonnegative integer",
        )
        require(type(row.get("qualified")) is bool, "qualified must be boolean")
        require(row.get("overall") in ("pass", "warn", "fail"), "invalid overall")
        require(isinstance(row.get("tests"), dict), "missing tests")
        require(isinstance(row.get("results"), dict), "missing results")
        require(
            all(
                s in ("pass", "fail", "warn", "skip", "missing")
                for s in row["results"].values()
            ),
            "invalid test result",
        )
        report = row.get("report_url")
        require(
            safe_path(report) and report.startswith("reports/"), "invalid report_url"
        )
        channel = (
            row.get("channel")
            if source["channel"] == "from-record"
            else source["channel"]
        )
        require(channel in ("stable", "nightly"), "invalid qualification channel")
        system_os = row.get("os") or source.get("os")
        system_os = {"ubuntu": "linux", "win": "windows"}.get(system_os, system_os)
        require(system_os in ("linux", "windows", "macos"), "unknown qualification os")
        rows.append(
            {
                **row,
                "source_id": source["id"],
                "engine": source["engine"],
                "channel": channel,
                "os": system_os,
                "hardware_validated": row.get("hardware_validated"),
                "report_url": urljoin(url, report),
                "source_pointer": f"/builds/{len(rows)}",
            }
        )
    return rows


def pointer(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def normalize_performance(source, data):
    require(
        isinstance(data.get("by_model_scenario"), dict), "missing by_model_scenario"
    )
    require(isinstance(data.get("history"), dict), "missing history")
    require(isinstance(data.get("systems"), list), "missing systems")
    require(
        all(
            isinstance(system, dict) and isinstance(system.get("id"), str)
            for system in data["systems"]
        ),
        "invalid system metadata",
    )
    system_ids = [system["id"] for system in data["systems"]]
    require(len(system_ids) == len(set(system_ids)), "duplicate system id")
    rows = []

    def append(row, fork_id, model, scenario, kind, location):
        require(fork_id in source["forks"], f"unknown fork: {fork_id}")
        fork = source["forks"][fork_id]
        require(
            row.get("hw_id") is None or row["hw_id"] in system_ids, "unknown system id"
        )
        for field in ("timestamp", "run_url"):
            require(isinstance(row.get(field), str) and row[field], f"missing {field}")
        timestamp(row["timestamp"])
        for metric in METRICS:
            value = row.get(metric)
            require(
                value is None
                or (
                    type(value) in (int, float) and math.isfinite(value) and value >= 0
                ),
                f"invalid {metric}",
            )
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
                "engine_version": (
                    row.get("fork_version") if kind == "latest" else row.get("version")
                ),
                "model": model,
                "scenario": scenario,
                "quant": row.get("quant"),
                "system_id": row.get("hw_id"),
                "context_size": row.get("ctx_size"),
                "input_tokens": row.get("input_tokens"),
                "measured_at": row["timestamp"],
                "run_id": row.get("run_id"),
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
        require(isinstance(entries, list), "performance entries must be an array")
        for index, row in enumerate(entries):
            append(
                row,
                row["fork_id"],
                row["model"],
                row["scenario"],
                "latest",
                f"/by_model_scenario/{pointer(group)}/{index}",
            )
    for model, scenarios in data["history"].items():
        for scenario, forks in scenarios.items():
            for fork_id, entries in forks.items():
                for index, row in enumerate(entries):
                    append(
                        row,
                        fork_id,
                        model,
                        scenario,
                        "history",
                        f"/history/{pointer(model)}/{pointer(scenario)}/{pointer(fork_id)}/{index}",
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
        output["sources"].append(state)
        if source.get("availability") == "awaiting_data":
            print(f"{sid}: awaiting_data (not fetched)", flush=True)
            continue
        try:
            repo, ref = source["repository"], source["ref"]
            key = (repo, ref)
            if key not in commits:
                commits[key] = fetch(
                    f'https://api.github.com/repos/{repo}/commits/{quote(ref, safe="")}'
                )["sha"]
            commit = commits[key]
            require(
                re.fullmatch(r"[a-f0-9]{40}", commit) is not None,
                "invalid source commit",
            )
            url = f'https://raw.githubusercontent.com/{repo}/{commit}/{quote(source["path"], safe="/")}'
            state.update(repository=repo, ref=ref, commit=commit, url=url)
            print(f"{sid}: fetching {url}", flush=True)
            data = fetch(url)
            snapshot = f"raw/{sid}.json"
            state.update(
                snapshot=snapshot, sha256=write_json(destination / snapshot, data)
            )
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
                    else "performance/unassigned.json"
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
            state.update(status="error", error=f"{type(error).__name__}: {error}")
            output["collection_status"] = "degraded"
            print(f'{sid}: ERROR {state["error"]}', file=sys.stderr, flush=True)
    evidence = list(package_evidence or [])
    if previous_data is not None:
        previous_root = Path(previous_data).resolve()
        prior_evidence = previous_root / "provenance/packages.json"
        if prior_evidence.exists():
            prior_evidence.resolve().relative_to(previous_root)
            saved = json.loads(prior_evidence.read_text(encoding="utf-8"))
            require(saved.get("schema_version") == 1, "invalid package evidence schema")
            require(isinstance(saved.get("packages"), list), "invalid package evidence")
            evidence.extend(saved["packages"])
    attribute_stable(output, evidence, resolve_packages)
    for source in output["sources"]:
        if source["adapter"] == "lemonade-leaderboard-v1" and source["status"] not in (
            "error",
            "awaiting_data",
        ):
            source["destination"] = (
                "rocm/*/performance.json + performance/unassigned.json"
            )
    write_json(
        destination / "provenance/packages.json",
        {
            "schema_version": 1,
            "packages": output["package_evidence"],
        },
    )
    output["dataset"] = write_dataset(output, destination, previous_data=previous_data)
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
    try:
        evidence = json.loads(args.package_evidence.read_text(encoding="utf-8"))
        require(evidence.get("schema_version") == 1, "invalid package evidence schema")
        output = collect(
            json.loads(args.sources.read_text(encoding="utf-8")),
            args.output_dir,
            previous_data=args.previous_data,
            package_evidence=evidence["packages"],
            resolve_packages=resolve_package,
        )
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"Collection error: {error}", file=sys.stderr)
        try:
            write_json(
                args.output_dir / "index.json",
                {
                    "schema_version": 2,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "collection_status": "degraded",
                    "error": str(error),
                    "versions": [],
                },
            )
        except OSError as write_error:
            print(f"Could not write diagnostic index: {write_error}", file=sys.stderr)
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
    summary = "\n".join(lines) + "\n"
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(summary)
    return 0 if output["collection_status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())

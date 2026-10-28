"""Write the compact, versioned dataset consumed by the readiness UI."""

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
from typing import Dict, Optional
from urllib.parse import urlparse

if __package__:
    from .attribution import PACKAGE, RUN
    from .validation import PipelineValidationError
else:
    from attribution import PACKAGE, RUN
    from validation import PipelineValidationError

BUILD_FIELDS = """
source_id build_id engine tag artifact rocm_version channel os gfx_target hardware_validated gfx
qualified version_qualified overall generated_at run_attempt tests blocked_by blocking_tests
report_url run_url source_pointer
""".split()
MEASUREMENT_FIELDS = """
source_id source_pointer kind engine channel backend fork_id engine_repository engine_version
model scenario quant system_id context_size input_tokens measured_at run_id run_url
lemonade_version metrics rocm_version qualification_build_id accuracy_verdict producer_accuracy
source_url package_url package_os attribution
""".split()
SYSTEM_FIELDS = """
id source_id cpu gpu gpu_full os memory ram_gb vram_gb source_pointer gfx_target
""".split()
JSON_OPTIONS = {"ensure_ascii": False, "allow_nan": False, "separators": (",", ":")}
RAW_SOURCE_URL = re.compile(
    r"https://raw\.githubusercontent\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[a-f0-9]{40}/[^?#]+"
)


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _timestamp(value):
    _require(isinstance(value, str), "timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require(parsed.tzinfo is not None, "timestamp must include timezone")
    return parsed


def _version_key(value):
    _require(
        isinstance(value, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value),
        "invalid ROCm version",
    )
    return tuple(int(part) for part in value.split(".")), value


def _https_url(value):
    if not isinstance(value, str) or any(char.isspace() for char in value):
        return False
    try:
        parsed = urlparse(value)
        return parsed.scheme == "https" and bool(parsed.hostname)
    except ValueError:
        return False


def _json_pointer(value):
    return isinstance(value, str) and (
        not value
        or (value.startswith("/") and re.search(r"~(?:[^01]|$)", value) is None)
    )


def _string_list(value):
    return value is None or (
        isinstance(value, list) and all(isinstance(item, str) for item in value)
    )


def _validate_build(row):
    _require(type(row["qualified"]) is bool, "invalid qualified")
    _require(
        row["version_qualified"] is None or type(row["version_qualified"]) is bool,
        "invalid version_qualified",
    )
    _require(row["overall"] in ("pass", "warn", "fail"), "invalid overall")
    _require(
        type(row["run_attempt"]) is int and row["run_attempt"] >= 0,
        "invalid run_attempt",
    )
    _require(_json_pointer(row["source_pointer"]), "invalid source_pointer")
    _require(
        _https_url(row["report_url"]) and _https_url(row["run_url"]),
        "invalid report or run URL",
    )
    _require(
        isinstance(row["tests"], dict)
        and all(type(value) is int and value >= 0 for value in row["tests"].values()),
        "invalid test counts",
    )
    _require(
        _string_list(row["blocked_by"]) and _string_list(row["blocking_tests"]),
        "invalid blocking tests",
    )
    _require(
        row["hardware_validated"] is None or type(row["hardware_validated"]) is bool,
        "invalid hardware_validated",
    )
    _require(
        RAW_SOURCE_URL.fullmatch(row["source_url"]) is not None,
        "invalid immutable source_url",
    )


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, **JSON_OPTIONS)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _compact_build(row, source_urls=None, strict=False, version=None, month=None):
    _require(isinstance(row, dict), "invalid build")
    source_id = row.get("source_id")
    _require(isinstance(source_id, str) and source_id, "missing build source")
    source_url = (
        row.get("source_url") if source_urls is None else source_urls.get(source_id)
    )
    _require(isinstance(source_url, str) and source_url, "missing source url")
    _require(
        isinstance(row.get("build_id"), str) and row["build_id"], "missing build id"
    )
    _require(isinstance(row.get("engine"), str), "missing build engine")
    _version_key(row.get("rocm_version"))
    created = _timestamp(row.get("generated_at"))
    if strict:
        _require(
            all(
                field in row
                for field in BUILD_FIELDS + ["source_url"]
                if field != "artifact"
            ),
            "truncated previous build",
        )
    if version is not None:
        _require(
            row["rocm_version"] == version and created.strftime("%Y-%m") == month,
            "invalid previous build",
        )
    compact = {field: row.get(field) for field in BUILD_FIELDS}
    summary = row.get("summary")
    if compact["blocking_tests"] is None and isinstance(summary, dict):
        compact["blocking_tests"] = summary.get("blocking_tests")
    compact["source_url"] = source_url
    _validate_build(compact)
    return compact


def _project(rows, fields):
    _require(all(isinstance(row, dict) for row in rows), "invalid records")
    return [{field: row.get(field) for field in fields} for row in rows]


def _read_previous(root, relative):
    _require(
        isinstance(relative, str) and "\\" not in relative, "invalid previous path"
    )
    relative_path = PurePosixPath(relative)
    _require(
        relative_path.parts
        and not relative_path.is_absolute()
        and all(
            part not in ("", ".", "..") and ":" not in part
            for part in relative_path.parts
        ),
        "invalid previous path",
    )
    try:
        path = root.joinpath(*relative_path.parts).resolve(strict=True)
        path.relative_to(root)
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, RuntimeError, UnicodeError, ValueError) as error:
        raise ValueError("invalid previous data path or JSON") from error


def _load_previous(previous_data):
    try:
        root = Path(previous_data).resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError("previous data is unavailable") from error
    _require(root.is_dir(), "previous data must be a directory")
    index = _read_previous(root, "index.json")
    _require(
        isinstance(index, dict)
        and index.get("schema_version") == 2
        and index.get("collection_status") == "complete"
        and isinstance(index.get("versions"), list),
        "invalid previous index",
    )
    builds, seen_versions, measurements, systems = {}, set(), {}, {}
    for version_item in index["versions"]:
        _require(isinstance(version_item, dict), "invalid previous version")
        version = version_item.get("rocm_version")
        _version_key(version)
        _require(version not in seen_versions, "duplicate previous version")
        seen_versions.add(version)
        _require(
            version_item.get("overview") == f"rocm/{version}/overview.json",
            "invalid previous overview path",
        )
        overview = _read_previous(root, version_item.get("overview"))
        _require(
            isinstance(overview, dict)
            and overview.get("schema_version") == 2
            and overview.get("rocm_version") == version
            and isinstance(overview.get("history"), list),
            "invalid previous overview",
        )
        performance = overview.get("performance", {})
        _require(isinstance(performance, dict), "invalid previous performance")
        if performance.get("path") is not None:
            _require(
                performance.get("status") == "available", "invalid previous performance"
            )
            _require(
                performance["path"] == f"rocm/{version}/performance.json",
                "invalid performance path",
            )
            data = _read_previous(root, performance["path"])
            _require(
                isinstance(data, dict)
                and data.get("schema_version") == 2
                and isinstance(data.get("measurements"), list)
                and isinstance(data.get("systems"), list)
                and type(performance.get("measurement_count")) is int
                and performance["measurement_count"] == len(data["measurements"]),
                "invalid previous performance",
            )
            local_systems = {}
            for system in data["systems"]:
                _require(
                    isinstance(system, dict)
                    and isinstance(system.get("id"), str)
                    and isinstance(system.get("source_id"), str),
                    "invalid previous system",
                )
                key = (system["source_id"], system["id"])
                _require(key not in local_systems, "duplicate previous system")
                local_systems[key] = system
                systems[(version, *key)] = system
            for row in data["measurements"]:
                _validate_assigned(row, version)
                key = _measurement_key(row)
                _require(key not in measurements, "duplicate previous measurement")
                _require(
                    row.get("system_id") is None
                    or (row["source_id"], row["system_id"]) in local_systems,
                    "missing previous system",
                )
                measurements[key] = row
            _require(
                performance.get("latest_measurements")
                == _latest_measurements(data["measurements"]),
                "invalid previous latest measurements",
            )
        else:
            _require(
                performance.get("status") != "available",
                "missing previous performance path",
            )
        total, seen_months = 0, set()
        for history_item in overview["history"]:
            _require(isinstance(history_item, dict), "invalid previous history")
            month = history_item.get("month")
            _require(
                isinstance(month, str)
                and re.fullmatch(r"[0-9]{4}-[0-9]{2}", month)
                and month not in seen_months,
                "invalid previous history",
            )
            seen_months.add(month)
            _require(
                history_item.get("path") == f"rocm/{version}/history/{month}.json",
                "invalid previous history path",
            )
            chunk = _read_previous(root, history_item.get("path"))
            _require(
                isinstance(chunk, dict)
                and chunk.get("schema_version") == 2
                and chunk.get("rocm_version") == version
                and chunk.get("month") == month
                and isinstance(chunk.get("builds"), list)
                and type(history_item.get("build_count")) is int
                and history_item["build_count"] == len(chunk["builds"]),
                "invalid previous history",
            )
            total += len(chunk["builds"])
            for raw in chunk["builds"]:
                row = _compact_build(raw, strict=True, version=version, month=month)
                key = (row["source_id"], row["build_id"])
                _require(key not in builds, "duplicate previous build")
                builds[key] = row
        _require(
            type(version_item.get("build_count")) is int
            and version_item["build_count"] == total,
            "corrupt previous count",
        )
    return builds, measurements, systems


def _unique_builds(rows):
    indexed = {}
    for row in rows:
        key = (row["source_id"], row["build_id"])
        _require(key not in indexed, "duplicate current build")
        indexed[key] = row
    return indexed


def _build_key(row):
    return (
        _timestamp(row["generated_at"]),
        row["run_attempt"],
        row["source_id"],
        row["build_id"],
    )


def _sort_builds(rows):
    return sorted(rows, key=_build_key, reverse=True)


def _measurement_key(row):
    fields = (
        "source_id",
        "fork_id",
        "engine_version",
        "model",
        "scenario",
        "quant",
        "measured_at",
        "run_id",
    )
    _require(isinstance(row, dict), "invalid measurement")
    _require(
        all(
            isinstance(row.get(f), str) and row[f]
            for f in (
                "source_id",
                "fork_id",
                "engine_version",
                "model",
                "scenario",
                "measured_at",
            )
        ),
        "invalid measurement identity",
    )
    _require(
        all(
            row.get(f) is None
            or isinstance(row[f], (str, int))
            and not isinstance(row[f], bool)
            for f in ("quant", "run_id")
        ),
        "invalid measurement identity",
    )
    _timestamp(row["measured_at"])
    return tuple(row.get(f) for f in fields)


def _validate_assigned(row, version):
    _measurement_key(row)
    _require(row.get("rocm_version") == version, "invalid measurement version")
    _require(
        isinstance(row.get("source_url"), str)
        and RAW_SOURCE_URL.fullmatch(row["source_url"]) is not None,
        "invalid measurement source",
    )
    _require(_json_pointer(row.get("source_pointer")), "invalid measurement pointer")
    package = row.get("package_url")
    parsed = PACKAGE.fullmatch(package) if isinstance(package, str) else None
    _require(parsed is not None, "invalid package URL")
    _require(
        parsed[1] == row.get("engine_repository")
        and parsed[2] == row.get("engine_version")
        and parsed[4] == row.get("rocm_version")
        and row.get("package_os") == {"ubuntu": "linux", "win": "windows"}[parsed[3]]
        and parsed[5] == {"ubuntu": "tar.gz", "win": "zip"}[parsed[3]],
        "package identity mismatch",
    )
    run = (
        RUN.fullmatch(row.get("run_url", ""))
        if isinstance(row.get("run_url"), str)
        else None
    )
    _require(
        run is not None and str(row.get("run_id")) == run[2], "invalid measurement run"
    )
    attribution = row.get("attribution")
    _require(
        isinstance(attribution, dict)
        and attribution.get("status") in ("rocm_identified", "matched")
        and attribution.get("package_url") == package
        and isinstance(attribution.get("evidence_url"), str)
        and re.fullmatch(
            r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+/job/[0-9]+",
            attribution["evidence_url"],
        )
        and isinstance(attribution.get("log_sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", attribution["log_sha256"]),
        "invalid attribution evidence",
    )
    _require(
        re.fullmatch(
            re.escape(row["run_url"]) + r"/job/[0-9]+", attribution["evidence_url"]
        ),
        "attribution job does not match run",
    )
    _require(
        (attribution["status"] == "matched")
        == (
            isinstance(row.get("qualification_build_id"), str)
            and bool(row["qualification_build_id"])
        ),
        "invalid attribution match",
    )


def _join_measurement(row, builds):
    matches = []
    for build in builds:
        parts = urlparse(build["source_url"]).path.split("/")
        repository = "/".join(parts[1:3])
        if (
            row.get("engine") == build.get("engine")
            and row.get("engine_repository") == repository
            and row.get("engine_version") == build.get("tag")
            and row.get("rocm_version") == build.get("rocm_version")
            and row.get("package_os") == build.get("os")
            and urlparse(row["package_url"]).path.rsplit("/", 1)[-1]
            == build.get("artifact")
        ):
            matches.append(build)
    if len(matches) > 1:
        raise PipelineValidationError(
            row["source_id"],
            row["source_pointer"],
            "qualification_build_id",
            "ambiguous qualification builds for the exact package",
        )
    row["attribution"] = dict(row["attribution"])
    row["qualification_build_id"] = (
        matches[0]["build_id"] if len(matches) == 1 else None
    )
    row["attribution"]["status"] = "matched" if len(matches) == 1 else "rocm_identified"
    if len(matches) == 1:
        row["attribution"].pop("reason", None)
    else:
        row["attribution"]["reason"] = (
            "no matching qualification build"
            if not matches
            else "ambiguous qualification builds"
        )
    return row


def _systems_for(rows, systems):
    keys = {
        (row.get("source_id"), row.get("system_id"))
        for row in rows
        if row.get("system_id") is not None
    }
    _require(keys <= systems.keys(), "measurement references missing system")
    return [systems[key] for key in sorted(keys)]


def _latest_measurements(rows):
    latest = {}
    for row in rows:
        key = tuple(
            row.get(field)
            for field in (
                "engine",
                "channel",
                "model",
                "scenario",
                "quant",
                "system_id",
            )
        )
        if key not in latest or _timestamp(row["measured_at"]) > _timestamp(
            latest[key]["measured_at"]
        ):
            latest[key] = row
    return [
        latest[key] for key in sorted(latest, key=lambda k: tuple(str(x) for x in k))
    ]


def _write_version(
    destination,
    version,
    rows,
    engines,
    generated_at,
    measurements,
    systems,
    has_unassigned,
):
    by_engine = {engine["id"]: [] for engine in engines}
    by_month = {}
    for row in rows:
        _require(row["engine"] in by_engine, "build references an unconfigured engine")
        by_engine[row["engine"]].append(row)
        by_month.setdefault(
            _timestamp(row["generated_at"]).strftime("%Y-%m"), []
        ).append(row)

    history = []
    for month in sorted(by_month, reverse=True):
        path = f"rocm/{version}/history/{month}.json"
        chunk = {
            "schema_version": 2,
            "rocm_version": version,
            "month": month,
            "builds": _sort_builds(by_month[month]),
        }
        _write_json(destination / path, chunk)
        history.append(
            {"month": month, "path": path, "build_count": len(chunk["builds"])}
        )

    cards = []
    for engine in engines:
        latest = {}
        for row in by_engine[engine["id"]]:
            key = (row.get("channel"), row.get("os"), row.get("gfx_target"))
            prior = latest.get(key)
            if prior is None or _build_key(row) > _build_key(prior):
                latest[key] = row
        cards.append(
            {
                **engine,
                "build_count": len(by_engine[engine["id"]]),
                "latest_builds": [
                    latest[key]
                    for key in sorted(
                        latest, key=lambda item: tuple(str(x) for x in item)
                    )
                ],
            }
        )
    performance = {
        "status": "awaiting_attribution" if has_unassigned else "not_measured"
    }
    if measurements:
        path = f"rocm/{version}/performance.json"
        _write_json(
            destination / path,
            {
                "schema_version": 2,
                "measurements": measurements,
                "systems": _systems_for(measurements, systems),
            },
        )
        performance = {
            "status": "available",
            "measurement_count": len(measurements),
            "path": path,
            "latest_measurements": _latest_measurements(measurements),
        }
    overview = {
        "schema_version": 2,
        "generated_at": generated_at,
        "rocm_version": version,
        "engines": cards,
        "history": history,
        "performance": performance,
    }
    _write_json(destination / f"rocm/{version}/overview.json", overview)
    return len(rows)


def write_dataset(
    output: Dict,
    destination: Path,
    previous_data: Optional[Path] = None,
    publish_index: bool = True,
) -> Dict:
    """Write schema-v2 UI files for a normalized schema-v1 collector output."""
    _require(
        isinstance(output, dict) and output.get("schema_version") == 1,
        "unsupported output schema",
    )
    for key in ("engines", "sources", "builds", "measurements", "systems"):
        _require(isinstance(output.get(key), list), f"missing {key}")
    _timestamp(output.get("generated_at"))
    destination = Path(destination)
    engines = output["engines"]
    _require(
        all(
            isinstance(engine, dict) and isinstance(engine.get("id"), str)
            for engine in engines
        ),
        "invalid engines",
    )
    source_urls = {
        source.get("id"): source.get("url")
        for source in output["sources"]
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    compact = _unique_builds(
        [_compact_build(row, source_urls) for row in output["builds"]]
    )
    prior_measurements, prior_systems = {}, {}
    if previous_data is not None and output.get("collection_status") == "complete":
        previous, prior_measurements, prior_systems = _load_previous(previous_data)
        for key, row in compact.items():
            old = previous.get(key)
            if (
                old
                and row.get("artifact") is None
                and all(
                    row.get(field) == old.get(field)
                    for field in ("engine", "tag", "rocm_version", "os")
                )
                and urlparse(row["source_url"]).path.split("/")[1:3]
                == urlparse(old["source_url"]).path.split("/")[1:3]
            ):
                row["artifact"] = old.get("artifact")
        previous.update(compact)
        compact = previous
    systems = {}
    for system in _project(output["systems"], SYSTEM_FIELDS):
        _require(
            isinstance(system.get("id"), str)
            and isinstance(system.get("source_id"), str),
            "invalid system",
        )
        systems[(system["source_id"], system["id"])] = system
    current = {}
    unassigned = []
    for raw in output["measurements"]:
        row = {field: raw.get(field) for field in MEASUREMENT_FIELDS}
        row["source_url"] = row["source_url"] or source_urls.get(row["source_id"])
        if row["rocm_version"] is not None:
            _version_key(row["rocm_version"])
            _validate_assigned(row, row["rocm_version"])
        try:
            key = _measurement_key(row)
        except ValueError:
            if row["rocm_version"] is not None:
                raise
            unassigned.append(row)
            continue
        existing = current.get(key)
        if (
            existing is None
            or row.get("kind") == "latest"
            and existing.get("kind") != "latest"
        ):
            if existing is not None:
                for field in ("system_id", "context_size", "input_tokens"):
                    if row.get(field) is None:
                        row[field] = existing.get(field)
            current[key] = row
        elif existing is not None:
            for field in ("system_id", "context_size", "input_tokens"):
                if existing.get(field) is None:
                    existing[field] = row.get(field)
    version_systems_map = {}
    for (version, source, system_id), system in prior_systems.items():
        version_systems_map.setdefault(version, {})[(source, system_id)] = system
    for key, row in current.items():
        if row["rocm_version"] is None:
            if key not in prior_measurements:
                unassigned.append(row)
            continue
        prior_row = prior_measurements.get(key)
        inherited_system = False
        if prior_row:
            for field in ("system_id", "context_size", "input_tokens"):
                if row.get(field) is None:
                    row[field] = prior_row.get(field)
                    if field == "system_id" and row[field] is not None:
                        inherited_system = True
            old_accuracy = prior_row.get("producer_accuracy")
            if isinstance(old_accuracy, dict):
                accuracy = row.get("producer_accuracy")
                if accuracy is None:
                    row["producer_accuracy"] = old_accuracy
                elif isinstance(accuracy, dict):
                    row["producer_accuracy"] = {
                        **old_accuracy,
                        **{k: v for k, v in accuracy.items() if v is not None},
                    }
        version_systems = version_systems_map.setdefault(row["rocm_version"], {})
        system_key = (row["source_id"], row["system_id"])
        if row["system_id"] is not None:
            if inherited_system:
                _require(
                    system_key in version_systems,
                    "measurement references missing previous system",
                )
                prior_measurements[key] = _join_measurement(row, compact.values())
                continue
            _require(system_key in systems, "measurement references missing system")
            current_system = systems[system_key]
            old_system = version_systems.get(system_key)

            def identity(system):
                return {
                    k: v for k, v in system.items() if k not in ("id", "source_pointer")
                }

            if old_system is not None and identity(old_system) != identity(
                current_system
            ):
                digest = hashlib.sha256(
                    json.dumps(
                        identity(current_system), sort_keys=True, **JSON_OPTIONS
                    ).encode()
                ).hexdigest()
                new_id = f"{row['system_id']}--{digest}"
                new_key = (row["source_id"], new_id)
                _require(
                    new_key not in version_systems
                    or identity(version_systems[new_key]) == identity(current_system),
                    "system identity collision",
                )
                row["system_id"] = new_id
                version_systems[new_key] = {**current_system, "id": new_id}
            else:
                version_systems[system_key] = old_system or current_system
        prior_measurements[key] = _join_measurement(row, compact.values())
    assigned = {}
    for row in prior_measurements.values():
        assigned.setdefault(row["rocm_version"], []).append(row)
    grouped = {}
    for row in compact.values():
        grouped.setdefault(row["rocm_version"], []).append(row)

    versions = []
    for version in sorted(set(grouped) | set(assigned), key=_version_key, reverse=True):
        version_systems = version_systems_map.get(version, {})
        count = _write_version(
            destination,
            version,
            grouped.get(version, []),
            engines,
            output["generated_at"],
            assigned.get(version, []),
            version_systems,
            bool(unassigned),
        )
        versions.append(
            {
                "rocm_version": version,
                "overview": f"rocm/{version}/overview.json",
                "build_count": count,
            }
        )
    performance = {
        "schema_version": 2,
        "measurements": unassigned,
        "systems": _systems_for(unassigned, systems),
    }
    _write_json(destination / "performance/unassigned.json", performance)
    index = {
        "schema_version": 2,
        "generated_at": output["generated_at"],
        "collection_status": output.get("collection_status"),
        "engines": engines,
        "sources": output["sources"],
        "reference_model": output.get("reference_model"),
        "default_version": versions[0]["rocm_version"] if versions else None,
        "versions": versions,
        "unassigned_performance": {
            "count": len(performance["measurements"]),
            "path": "performance/unassigned.json",
        },
        "stable_performance": {
            "assigned_count": sum(
                row.get("engine") == "llamacpp" and row.get("channel") == "stable"
                for rows in assigned.values()
                for row in rows
            ),
            "awaiting_evidence_count": sum(
                row.get("engine") == "llamacpp" and row.get("channel") == "stable"
                for row in unassigned
            ),
        },
    }
    if publish_index:
        _write_json(destination / "index.json", index)
    return index

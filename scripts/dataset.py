"""Write the compact, versioned dataset consumed by the readiness UI."""

from datetime import datetime
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
from typing import Dict, Optional
from urllib.parse import urlparse

BUILD_FIELDS = """
source_id build_id engine tag rocm_version channel os gfx_target hardware_validated gfx
qualified version_qualified overall generated_at run_attempt tests blocked_by blocking_tests
report_url run_url source_pointer
""".split()
MEASUREMENT_FIELDS = """
source_id source_pointer kind engine channel backend fork_id engine_repository engine_version
model scenario quant system_id context_size input_tokens measured_at run_id run_url
lemonade_version metrics rocm_version qualification_build_id accuracy_verdict
""".split()
SYSTEM_FIELDS = """
id source_id cpu gpu gpu_full os memory ram_gb vram_gb source_pointer
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
            all(field in row for field in BUILD_FIELDS + ["source_url"]),
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
    builds, seen_versions = {}, set()
    for version_item in index["versions"]:
        _require(isinstance(version_item, dict), "invalid previous version")
        version = version_item.get("rocm_version")
        _version_key(version)
        _require(version not in seen_versions, "duplicate previous version")
        seen_versions.add(version)
        overview = _read_previous(root, version_item.get("overview"))
        _require(
            isinstance(overview, dict)
            and overview.get("schema_version") == 2
            and overview.get("rocm_version") == version
            and isinstance(overview.get("history"), list),
            "invalid previous overview",
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
    return builds


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


def _write_version(destination, version, rows, engines, generated_at, measurements):
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
    overview = {
        "schema_version": 2,
        "generated_at": generated_at,
        "rocm_version": version,
        "engines": cards,
        "history": history,
        "performance": {
            "status": "awaiting_attribution" if measurements else "not_measured"
        },
    }
    _write_json(destination / f"rocm/{version}/overview.json", overview)
    return len(rows)


def write_dataset(
    output: Dict, destination: Path, previous_data: Optional[Path] = None
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
    if previous_data is not None and output.get("collection_status") == "complete":
        previous = _load_previous(previous_data)
        previous.update(compact)
        compact = previous
    grouped = {}
    for row in compact.values():
        grouped.setdefault(row["rocm_version"], []).append(row)

    versions = []
    for version in sorted(grouped, key=_version_key, reverse=True):
        count = _write_version(
            destination,
            version,
            grouped[version],
            engines,
            output["generated_at"],
            output["measurements"],
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
        "measurements": _project(output["measurements"], MEASUREMENT_FIELDS),
        "systems": _project(output["systems"], SYSTEM_FIELDS),
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
    }
    _write_json(destination / "index.json", index)
    return index

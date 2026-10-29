"""Validate published JSON contracts and cross-file mapping invariants.

This reader deliberately does not call the dataset writer or its selection helpers.
Diagnostics name the output file, JSON pointer and independent mapping evidence.
"""

from datetime import datetime
import json
import math
from pathlib import Path, PurePosixPath
import re
from urllib.parse import urlparse

if __package__:
    from .attribution import validate_measurement_package
    from .validation import PipelineValidationError
else:
    from attribution import validate_measurement_package
    from validation import PipelineValidationError

RAW = re.compile(
    r"https://raw\.githubusercontent\.com/([^/]+/[^/]+)/([a-f0-9]{40})/[^?#]+"
)
BUILD_REQUIRED = set("""source_id build_id engine tag rocm_version channel os gfx_target
hardware_validated gfx qualified version_qualified overall generated_at run_attempt tests
blocked_by blocking_tests report_url run_url source_pointer source_url""".split())
MEASUREMENT_REQUIRED = set(
    """source_id source_pointer kind engine channel backend fork_id
engine_repository engine_version model scenario quant system_id context_size input_tokens
measured_at run_id run_url lemonade_version metrics rocm_version qualification_build_id
accuracy_verdict producer_accuracy source_url package_url package_os runtime_version
attribution""".split()
)
MEASUREMENT_ID = (
    "source_id",
    "fork_id",
    "engine_version",
    "model",
    "scenario",
    "quant",
    "measured_at",
    "run_id",
)


def _fail(path, field, evidence, source="pipeline"):
    raise PipelineValidationError(source, path, field, evidence)


def _check(ok, path, field, evidence, source="pipeline"):
    if not ok:
        _fail(path, field, evidence, source)


def _time(value, path, field):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed
    except (AttributeError, ValueError, TypeError):
        _fail(path, field, "expected an ISO timestamp with timezone")


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _integer(value):
    return type(value) is int and value >= 0


def _pointer(value):
    return isinstance(value, str) and (
        value == ""
        or value.startswith("/")
        and re.search(r"~(?:[^01]|$)", value) is None
    )


def _url(value):
    try:
        return (
            isinstance(value, str)
            and not any(x.isspace() for x in value)
            and urlparse(value).scheme == "https"
            and bool(urlparse(value).hostname)
        )
    except ValueError:
        return False


def _version(value, path, field):
    _check(
        isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)*", value),
        path,
        field,
        "expected a numeric ROCm version",
    )
    return tuple(int(part) for part in value.split(".")), value


def _same_records(left, right):
    # Missing additive nullable fields in saved history mean the same as null.
    def canonical(row):
        return {key: value for key, value in row.items() if value is not None}

    return [canonical(row) for row in left] == [canonical(row) for row in right]


def validate_dataset(root, config=None, *, check_live_pointer=True):
    """Return referenced paths after validating a complete schema-v2 dataset.

    ``root`` is the directory containing index.json. ``config`` is sources.json,
    when available; it adds configured source/fork/channel ownership checks.
    Optional latest.json/sync.json are checked without treating live failed
    attempts as changes to the immutable successful dataset.
    Collection disables the pointer check because only the publisher updates
    latest.json, after committing the new dataset.
    """
    root = Path(root).resolve()
    paths = set()

    def read(relative, owner=None, field="/"):
        owner = owner or relative
        _check(
            isinstance(relative, str) and "\\" not in relative,
            owner,
            field,
            "manifest path must be relative JSON",
        )
        parts = PurePosixPath(relative).parts
        _check(
            parts
            and not relative.startswith("/")
            and all(p not in ("..", ".") and ":" not in p for p in parts)
            and relative.endswith(".json"),
            owner,
            field,
            "manifest path must remain inside dataset",
        )
        target = root
        for part in parts:
            target = target / part
            _check(
                not target.is_symlink(),
                owner,
                field,
                "manifest paths cannot contain symlinks",
            )
        try:
            value = json.loads(
                target.read_text(encoding="utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (OSError, ValueError, UnicodeError) as error:
            _fail(owner, field, f"cannot read referenced JSON {relative}: {error}")
        _check(isinstance(value, dict), relative, "/", "expected a JSON object")
        paths.add(relative)
        return value

    def schema(value, path, version=2):
        _check(
            type(value.get("schema_version")) is int
            and value["schema_version"] == version,
            path,
            "/schema_version",
            f"expected schema version {version}",
        )

    def sequence(value, path, field):
        _check(isinstance(value, list), path, field, "expected an array")
        _check(
            all(isinstance(row, dict) for row in value),
            path,
            field,
            "expected object records",
        )
        return value

    index = read("index.json")
    schema(index, "index.json")
    for field in ("reference_model", "default_version"):
        _check(
            field in index,
            "index.json",
            "/" + field,
            "required catalog property must be present even when null",
        )
    _check(
        index.get("collection_status") == "complete",
        "index.json",
        "/collection_status",
        "conformance requires a complete collection",
    )
    _check(
        type(index.get("attribution_version")) is int
        and index["attribution_version"] == 2,
        "index.json",
        "/attribution_version",
        "expected package-evidence attribution version 2",
    )
    _time(index.get("generated_at"), "index.json", "/generated_at")
    engines = sequence(index.get("engines"), "index.json", "/engines")
    engine_map = {}
    for pos, engine in enumerate(engines):
        key = engine.get("id")
        _check(
            isinstance(key, str) and key and key not in engine_map,
            "index.json",
            f"/engines/{pos}/id",
            "engine IDs must be unique nonempty strings",
        )
        if "label" in engine:
            _check(
                isinstance(engine["label"], str),
                "index.json",
                f"/engines/{pos}/label",
                "expected engine label string",
            )
        if "platforms" in engine:
            _check(
                isinstance(engine["platforms"], list)
                and all(isinstance(item, str) for item in engine["platforms"]),
                "index.json",
                f"/engines/{pos}/platforms",
                "expected platform string array",
            )
        engine_map[key] = engine
    sources = sequence(index.get("sources"), "index.json", "/sources")
    source_map = {}
    for pos, source in enumerate(sources):
        key = source.get("id")
        _check(
            isinstance(key, str) and key and key not in source_map,
            "index.json",
            f"/sources/{pos}/id",
            "source IDs must be unique nonempty strings",
        )
        _check(
            isinstance(source.get("engine"), str) and source["engine"] in engine_map,
            "index.json",
            f"/sources/{pos}/engine",
            "source engine must be configured",
        )
        _check(
            source.get("status") in ("fresh", "stale", "empty", "awaiting_data"),
            "index.json",
            f"/sources/{pos}/status",
            "complete collections contain validated source states",
        )
        _check(
            _integer(source.get("record_count")),
            "index.json",
            f"/sources/{pos}/record_count",
            "expected nonnegative fetched-record count",
        )
        for field in ("repository", "ref", "url", "destination", "channel", "adapter"):
            if field in source:
                _check(
                    isinstance(source[field], str),
                    "index.json",
                    f"/sources/{pos}/{field}",
                    "expected source metadata string",
                    key,
                )
        for field in ("commit", "sha256"):
            if field in source:
                length = 40 if field == "commit" else 64
                _check(
                    isinstance(source[field], str)
                    and re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", source[field]),
                    "index.json",
                    f"/sources/{pos}/{field}",
                    "invalid producer checksum/revision",
                    key,
                )
        for field in ("age_hours", "stale_after_hours"):
            if field in source:
                _check(
                    source[field] is None
                    or _number(source[field])
                    and source[field] >= 0,
                    "index.json",
                    f"/sources/{pos}/{field}",
                    "expected nullable nonnegative numeric source age/threshold",
                    key,
                )
        if source.get("latest_observation_at") is not None:
            _time(
                source["latest_observation_at"],
                "index.json",
                f"/sources/{pos}/latest_observation_at",
            )
        if "include_forks" in source:
            _check(
                isinstance(source["include_forks"], list)
                and all(isinstance(item, str) for item in source["include_forks"]),
                "index.json",
                f"/sources/{pos}/include_forks",
                "expected included-fork string array",
                key,
            )
        if source.get("url") is not None:
            raw = RAW.fullmatch(source["url"])
            _check(
                raw is not None,
                "index.json",
                f"/sources/{pos}/url",
                "expected immutable producer commit URL",
                key,
            )
            if "commit" in source:
                _check(
                    raw[2] == source["commit"],
                    "index.json",
                    f"/sources/{pos}/url",
                    "producer URL must match recorded commit",
                    key,
                )
            if "repository" in source:
                _check(
                    raw[1] == source["repository"],
                    "index.json",
                    f"/sources/{pos}/url",
                    "producer URL must match recorded repository",
                    key,
                )
        source_map[key] = source
    configs = (
        None
        if config is None
        else {source["id"]: source for source in config["sources"]}
    )
    if config is not None:
        _check(
            engines == config["engines"],
            "index.json",
            "/engines",
            "engine catalog must equal sources.json /engines",
        )
        _check(
            set(source_map) == set(configs),
            "index.json",
            "/sources",
            "source catalog must equal sources.json /sources IDs",
        )
        for spos, source in enumerate(sources):
            cfg = configs[source["id"]]
            required = {"id", "engine", "channel", "adapter", "status", "record_count"}
            if source["status"] != "awaiting_data":
                required |= {
                    "repository",
                    "ref",
                    "commit",
                    "url",
                    "sha256",
                    "latest_observation_at",
                    "age_hours",
                    "stale_after_hours",
                    "destination",
                }
            _check(
                required <= source.keys(),
                "index.json",
                f"/sources/{spos}",
                "collected source metadata must include documented provenance and freshness fields",
                source["id"],
            )
            for field in (
                "engine",
                "channel",
                "adapter",
                "repository",
                "ref",
                "include_forks",
            ):
                if field in cfg:
                    _check(
                        source.get(field) == cfg[field],
                        "index.json",
                        f"/sources/{spos}/{field}",
                        "collected source metadata must match sources.json",
                        source["id"],
                    )

    def ownership(row, path, pointer, measurement=False):
        sid = row.get("source_id")
        _check(
            isinstance(sid, str) and sid in source_map,
            path,
            pointer + "/source_id",
            "record source must exist in index.json /sources",
        )
        source = source_map[sid]
        _check(
            source.get("status") != "awaiting_data",
            path,
            pointer + "/source_id",
            "awaiting-data sources cannot own retained records",
            sid,
        )
        _check(
            isinstance(row.get("engine"), str) and row["engine"] in engine_map,
            path,
            pointer + "/engine",
            "record engine must exist in index.json /engines",
            sid,
        )
        raw = (
            RAW.fullmatch(row.get("source_url", ""))
            if isinstance(row.get("source_url"), str)
            else None
        )
        _check(
            raw is not None,
            path,
            pointer + "/source_url",
            "source must be an immutable raw GitHub commit URL",
            sid,
        )
        _check(
            _pointer(row.get("source_pointer")),
            path,
            pointer + "/source_pointer",
            "source evidence must use a valid JSON pointer",
            sid,
        )
        cfg = configs.get(sid) if configs is not None else source
        _check(
            cfg.get("availability") != "awaiting_data",
            path,
            pointer + "/source_id",
            "configured awaiting-data source cannot own retained records",
            sid,
        )
        if cfg.get("repository"):
            _check(
                raw[1] == cfg["repository"],
                path,
                pointer + "/source_url",
                "source repository must match configured producer",
                sid,
            )
        if not measurement:
            _check(
                row.get("engine") == cfg.get("engine"),
                path,
                pointer + "/engine",
                "qualification engine must match its source owner",
                sid,
            )
            if cfg.get("channel") and cfg["channel"] != "from-record":
                _check(
                    row.get("channel") == cfg["channel"],
                    path,
                    pointer + "/channel",
                    "qualification channel must match its configured source",
                    sid,
                )
        else:
            _check(
                isinstance(row.get("fork_id"), str),
                path,
                pointer + "/fork_id",
                "expected configured fork string",
                sid,
            )
            if cfg.get("repository"):
                run = row.get("run_url")
                _check(
                    isinstance(run, str)
                    and run.startswith(
                        "https://github.com/" + cfg["repository"] + "/actions/runs/"
                    ),
                    path,
                    pointer + "/run_url",
                    "benchmark workflow must belong to configured producer repository",
                    sid,
                )
            if "include_forks" in cfg:
                _check(
                    row.get("fork_id") in cfg["include_forks"],
                    path,
                    pointer + "/fork_id",
                    "measurement fork must be explicitly included",
                    sid,
                )
            if "forks" in cfg:
                fork = cfg["forks"].get(row.get("fork_id"))
                _check(
                    fork is not None,
                    path,
                    pointer + "/fork_id",
                    "measurement fork must have configured ownership",
                    sid,
                )
                for dest, origin in (
                    ("engine", "engine"),
                    ("channel", "channel"),
                    ("backend", "backend"),
                    ("engine_repository", "repository"),
                ):
                    _check(
                        row.get(dest) == fork.get(origin),
                        path,
                        pointer + "/" + dest,
                        f"measurement {dest} must match sources.json fork {origin}",
                        sid,
                    )

    def validate_systems(systems, ppath):
        system_ids = set()
        for spos, system in enumerate(systems):
            key = (system.get("source_id"), system.get("id"))
            _check(
                all(isinstance(x, str) and x for x in key) and key not in system_ids,
                ppath,
                f"/systems/{spos}",
                "systems require unique source-scoped string identities",
            )
            _check(
                key[0] in source_map,
                ppath,
                f"/systems/{spos}/source_id",
                "system source must exist in index source catalog",
            )
            for field in ("cpu", "gpu", "os", "gfx_target"):
                _check(
                    system.get(field) is None or isinstance(system[field], str),
                    ppath,
                    f"/systems/{spos}/{field}",
                    "expected nullable system string",
                )
            for field in ("ram_gb", "vram_gb"):
                _check(
                    system.get(field) is None
                    or _number(system[field])
                    and system[field] >= 0,
                    ppath,
                    f"/systems/{spos}/{field}",
                    "expected nullable nonnegative memory amount",
                )
            gpu = system.get("gpu_full")
            _check(
                gpu is None or isinstance(gpu, (str, list)),
                ppath,
                f"/systems/{spos}/gpu_full",
                "expected nullable string or GPU-object array",
            )
            if isinstance(gpu, list):
                for gpos, device in enumerate(gpu):
                    gp = f"/systems/{spos}/gpu_full/{gpos}"
                    _check(
                        isinstance(device, dict)
                        and isinstance(device.get("name"), str)
                        and device["name"],
                        ppath,
                        gp,
                        "GPU entries require a nonempty name",
                    )
                    _check(
                        device.get("type") is None or isinstance(device["type"], str),
                        ppath,
                        gp + "/type",
                        "expected nullable GPU type string",
                    )
                    _check(
                        device.get("integrated") is None
                        or type(device["integrated"]) is bool,
                        ppath,
                        gp + "/integrated",
                        "expected nullable integrated flag",
                    )
                    _check(
                        device.get("vram_gb") is None
                        or _number(device["vram_gb"])
                        and device["vram_gb"] >= 0,
                        ppath,
                        gp + "/vram_gb",
                        "expected nullable nonnegative GPU memory",
                    )
            _check(
                system.get("source_pointer") is None
                or _pointer(system["source_pointer"]),
                ppath,
                f"/systems/{spos}/source_pointer",
                "expected nullable source JSON pointer",
            )
            system_ids.add(key)
        return system_ids

    versions = sequence(index.get("versions"), "index.json", "/versions")
    version_names = [row.get("rocm_version") for row in versions]
    order = [
        _version(value, "index.json", f"/versions/{pos}/rocm_version")
        for pos, value in enumerate(version_names)
    ]
    _check(
        len(set(version_names)) == len(version_names)
        and order == sorted(order, reverse=True),
        "index.json",
        "/versions",
        "versions must be unique in numeric descending order",
    )
    _check(
        index.get("default_version") == (version_names[0] if version_names else None),
        "index.json",
        "/default_version",
        "default must be the highest indexed ROCm version",
    )
    all_build_ids = set()
    stable_count = 0
    for vpos, entry in enumerate(versions):
        version = entry["rocm_version"]
        overview_path = f"rocm/{version}/overview.json"
        _check(
            entry.get("overview") == overview_path,
            "index.json",
            f"/versions/{vpos}/overview",
            "version overview path must match its ROCm version",
        )
        overview = read(overview_path)
        schema(overview, overview_path)
        _check(
            overview.get("rocm_version") == version,
            overview_path,
            "/rocm_version",
            "overview version must equal index entry",
        )
        _check(
            overview.get("generated_at") == index["generated_at"],
            overview_path,
            "/generated_at",
            "overview and index must describe the same collection",
        )
        history = sequence(overview.get("history"), overview_path, "/history")
        builds, months = [], []
        for hpos, chunk_entry in enumerate(history):
            month = chunk_entry.get("month")
            _check(
                isinstance(month, str)
                and re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", month),
                overview_path,
                f"/history/{hpos}/month",
                "expected a calendar YYYY-MM month",
            )
            path = f"rocm/{version}/history/{month}.json"
            _check(
                chunk_entry.get("path") == path,
                overview_path,
                f"/history/{hpos}/path",
                "monthly history path must agree with version and month",
            )
            chunk = read(path)
            schema(chunk, path)
            _check(
                chunk.get("rocm_version") == version and chunk.get("month") == month,
                path,
                "/",
                "history version/month must match manifest",
            )
            records = sequence(chunk.get("builds"), path, "/builds")
            ranked = []
            for bpos, row in enumerate(records):
                ptr = f"/builds/{bpos}"
                _check(
                    BUILD_REQUIRED <= row.keys(),
                    path,
                    ptr,
                    "build is missing documented required fields",
                )
                ownership(row, path, ptr)
                for key in ("build_id", "tag", "channel", "os"):
                    _check(
                        isinstance(row.get(key), str) and row[key],
                        path,
                        ptr + "/" + key,
                        "expected nonempty build identity string",
                        row["source_id"],
                    )
                identity = (row["source_id"], row["build_id"])
                _check(
                    identity not in all_build_ids,
                    path,
                    ptr,
                    f"retained identity {identity} must occur only once across history",
                    row["source_id"],
                )
                all_build_ids.add(identity)
                _check(
                    row.get("rocm_version") == version,
                    path,
                    ptr + "/rocm_version",
                    "build must remain in its measured ROCm version",
                    row["source_id"],
                )
                instant = _time(row.get("generated_at"), path, ptr + "/generated_at")
                _check(
                    instant.strftime("%Y-%m") == month,
                    path,
                    ptr + "/generated_at",
                    "history month derives from this build timestamp",
                    row["source_id"],
                )
                _check(
                    _integer(row.get("run_attempt")),
                    path,
                    ptr + "/run_attempt",
                    "expected nonnegative attempt number",
                    row["source_id"],
                )
                for key in ("qualified", "version_qualified", "hardware_validated"):
                    _check(
                        type(row.get(key)) is bool
                        or key != "qualified"
                        and row.get(key) is None,
                        path,
                        ptr + "/" + key,
                        "expected producer boolean (nullable for optional producer claim)",
                        row["source_id"],
                    )
                _check(
                    row.get("overall") in ("pass", "warn", "fail"),
                    path,
                    ptr + "/overall",
                    "expected producer overall verdict",
                    row["source_id"],
                )
                _check(
                    isinstance(row.get("tests"), dict)
                    and all(_integer(x) for x in row["tests"].values()),
                    path,
                    ptr + "/tests",
                    "test summary values must be nonnegative integers",
                    row["source_id"],
                )
                gfx = row.get("gfx")
                _check(
                    gfx is None
                    or isinstance(gfx, dict)
                    and all(
                        gfx.get(key) is None or _integer(gfx[key])
                        for key in ("requested", "present")
                    )
                    and (
                        gfx.get("missing") is None
                        or isinstance(gfx["missing"], list)
                        and all(isinstance(target, str) for target in gfx["missing"])
                    ),
                    path,
                    ptr + "/gfx",
                    "GPU coverage requires nullable counts and missing-target string array",
                    row["source_id"],
                )
                for key in ("report_url", "run_url"):
                    _check(
                        _url(row.get(key)),
                        path,
                        ptr + "/" + key,
                        "expected HTTPS evidence URL",
                        row["source_id"],
                    )
                cfg = (
                    configs[row["source_id"]]
                    if configs is not None
                    else source_map[row["source_id"]]
                )
                if cfg.get("adapter") == "qualification-v1":
                    base = row["source_url"].rsplit("/", 1)[0] + "/reports/"
                    report = row["report_url"]
                    suffix = report[len(base) :] if report.startswith(base) else ""
                    parts = PurePosixPath(suffix).parts
                    _check(
                        bool(parts)
                        and not suffix.startswith("/")
                        and "\\" not in suffix
                        and all(
                            part not in (".", "..") and ":" not in part
                            for part in parts
                        )
                        and "?" not in suffix
                        and "#" not in suffix,
                        path,
                        ptr + "/report_url",
                        "qualification-v1 report must retain the source commit directory and safe reports/ relative path",
                        row["source_id"],
                    )
                for key in ("blocked_by", "blocking_tests"):
                    _check(
                        row.get(key) is None
                        or isinstance(row[key], list)
                        and all(isinstance(x, str) for x in row[key]),
                        path,
                        ptr + "/" + key,
                        "expected nullable string array",
                        row["source_id"],
                    )
                statuses = row.get("results")
                _check(
                    statuses is None
                    or isinstance(statuses, dict)
                    and all(
                        isinstance(k, str)
                        and val in ("pass", "warn", "fail", "skip", "missing")
                        for k, val in statuses.items()
                    ),
                    path,
                    ptr + "/results",
                    "invalid producer test-status map",
                    row["source_id"],
                )
                _check(
                    row.get("upstream_sha") is None
                    or isinstance(row["upstream_sha"], str)
                    and re.fullmatch(r"[a-f0-9]{40}", row["upstream_sha"]),
                    path,
                    ptr + "/upstream_sha",
                    "expected nullable upstream commit SHA",
                    row["source_id"],
                )
                for key in ("event", "run_id", "artifact", "gfx_target"):
                    _check(
                        row.get(key) is None or isinstance(row[key], str),
                        path,
                        ptr + "/" + key,
                        "expected nullable string",
                        row["source_id"],
                    )
                ranked.append(
                    (instant, row["run_attempt"], row["source_id"], row["build_id"])
                )
            _check(
                ranked == sorted(ranked, reverse=True),
                path,
                "/builds",
                "history must be newest-first by date, attempt, source and build ID",
            )
            _check(
                _integer(chunk_entry.get("build_count"))
                and chunk_entry["build_count"] == len(records),
                overview_path,
                f"/history/{hpos}/build_count",
                f"count must equal {path} /builds length",
            )
            builds.extend(records)
            months.append(month)
        _check(
            months == sorted(set(months), reverse=True),
            overview_path,
            "/history",
            "history months must be unique and newest-first",
        )
        _check(
            _integer(entry.get("build_count")) and entry["build_count"] == len(builds),
            "index.json",
            f"/versions/{vpos}/build_count",
            f"count must equal {len(builds)} retained identities in {overview_path} history",
        )
        performance = overview.get("performance")
        _check(
            isinstance(performance, dict),
            overview_path,
            "/performance",
            "expected performance status object",
        )
        measurements = []
        if performance.get("status") == "available":
            ppath = f"rocm/{version}/performance.json"
            _check(
                performance.get("path") == ppath,
                overview_path,
                "/performance/path",
                "performance path must agree with ROCm version",
            )
            data = read(ppath)
            schema(data, ppath)
            measurements = sequence(data.get("measurements"), ppath, "/measurements")
            systems = sequence(data.get("systems"), ppath, "/systems")
            system_ids = validate_systems(systems, ppath)
            seen, used_systems, latest_measurements = set(), set(), {}
            for mpos, row in enumerate(measurements):
                ptr = f"/measurements/{mpos}"
                _check(
                    MEASUREMENT_REQUIRED <= row.keys(),
                    ppath,
                    ptr,
                    "measurement is missing documented required fields",
                )
                ownership(row, ppath, ptr, measurement=True)
                for key in (
                    "fork_id",
                    "engine_version",
                    "model",
                    "scenario",
                    "engine_repository",
                    "channel",
                    "backend",
                    "run_url",
                ):
                    _check(
                        isinstance(row.get(key), str) and row[key],
                        ppath,
                        ptr + "/" + key,
                        "expected nonempty measurement identity string",
                        row["source_id"],
                    )
                _check(
                    row.get("rocm_version") == version,
                    ppath,
                    ptr + "/rocm_version",
                    "measurement must remain in its attributed ROCm version",
                    row["source_id"],
                )
                instant = _time(row.get("measured_at"), ppath, ptr + "/measured_at")
                _check(
                    row.get("kind") in (None, "latest", "history"),
                    ppath,
                    ptr + "/kind",
                    "expected latest/history producer record kind",
                )
                for field in (
                    "system_id",
                    "lemonade_version",
                    "accuracy_verdict",
                    "runtime_version",
                ):
                    _check(
                        row.get(field) is None or isinstance(row[field], str),
                        ppath,
                        ptr + "/" + field,
                        "expected nullable measurement string",
                    )
                accuracy = row.get("producer_accuracy")
                _check(
                    accuracy is None or isinstance(accuracy, dict),
                    ppath,
                    ptr + "/producer_accuracy",
                    "expected nullable producer accuracy object",
                )
                if isinstance(accuracy, dict):
                    for name, value in accuracy.items():
                        valid = value is None or (
                            type(value) is bool
                            if name == "accuracy_pass"
                            else (
                                _number(value) and 0 <= value <= 1
                                if name == "accuracy"
                                else _integer(value)
                            )
                        )
                        _check(
                            valid,
                            ppath,
                            ptr + "/producer_accuracy/" + name,
                            "invalid copied producer accuracy statistic",
                        )
                for key in ("quant", "run_id"):
                    _check(
                        row.get(key) is None or type(row[key]) in (str, int),
                        ppath,
                        ptr + "/" + key,
                        "expected nullable string or integer identity",
                        row["source_id"],
                    )
                ident = tuple(row.get(key) for key in MEASUREMENT_ID)
                _check(
                    ident not in seen,
                    ppath,
                    ptr,
                    "measurement identity must occur only once",
                )
                seen.add(ident)
                metrics = row.get("metrics")
                _check(
                    isinstance(metrics, dict)
                    and all(
                        value is None or _number(value) and value >= 0
                        for value in metrics.values()
                    ),
                    ppath,
                    ptr + "/metrics",
                    "metrics must contain finite numbers or null",
                )
                for key in ("context_size", "input_tokens"):
                    _check(
                        row.get(key) is None
                        or _integer(row[key])
                        and (key != "context_size" or row[key] > 0),
                        ppath,
                        ptr + "/" + key,
                        "expected nullable nonnegative input count or positive context size",
                    )
                if row.get("system_id") is not None:
                    key = (row["source_id"], row["system_id"])
                    _check(
                        key in system_ids,
                        ppath,
                        ptr + "/system_id",
                        "measurement must reference its source-scoped system",
                    )
                    used_systems.add(key)
                try:
                    package = validate_measurement_package(row)
                except (ValueError, KeyError, TypeError) as error:
                    _fail(
                        ppath,
                        ptr + "/package_url",
                        f"package evidence validation failed: {error}",
                        row["source_id"],
                    )
                for key, source_key in (
                    ("engine_repository", "repository"),
                    ("engine_version", "version"),
                    ("rocm_version", "rocm_version"),
                    ("package_os", "os"),
                ):
                    _check(
                        row.get(key) == package[source_key],
                        ppath,
                        ptr + "/" + key,
                        f"field must match verified release package {source_key}",
                        row["source_id"],
                    )
                run = re.fullmatch(
                    r"https://github\.com/[^/]+/[^/]+/actions/runs/([0-9]+)",
                    row.get("run_url") or "",
                )
                _check(
                    run is not None and str(row.get("run_id")) == run[1],
                    ppath,
                    ptr + "/run_id",
                    "benchmark run ID must match benchmark workflow URL",
                    row["source_id"],
                )
                attribution = row.get("attribution")
                _check(
                    isinstance(attribution, dict)
                    and attribution.get("package_url") == row["package_url"],
                    ppath,
                    ptr + "/attribution",
                    "attribution must retain exact verified package URL",
                    row["source_id"],
                )
                _check(
                    isinstance(attribution.get("evidence_url"), str)
                    and re.fullmatch(
                        re.escape(row["run_url"]) + r"/job/[0-9]+",
                        attribution["evidence_url"],
                    ),
                    ppath,
                    ptr + "/attribution/evidence_url",
                    "package evidence job must belong to benchmark run",
                    row["source_id"],
                )
                _check(
                    isinstance(attribution.get("log_sha256"), str)
                    and re.fullmatch(r"[a-f0-9]{64}", attribution["log_sha256"]),
                    ppath,
                    ptr + "/attribution/log_sha256",
                    "package evidence must retain log SHA-256",
                    row["source_id"],
                )
                matches = [
                    build
                    for build in builds
                    if build["engine"] == row["engine"]
                    and RAW.fullmatch(build["source_url"])[1]
                    == row["engine_repository"]
                    and build["tag"] == row["engine_version"]
                    and build["os"] == row["package_os"]
                    and build.get("artifact") == row["package_url"].rsplit("/", 1)[-1]
                ]
                _check(
                    len(matches) <= 1,
                    ppath,
                    ptr + "/qualification_build_id",
                    "exact package identifies multiple qualification builds",
                    row["source_id"],
                )
                expected_id = matches[0]["build_id"] if matches else None
                _check(
                    row.get("qualification_build_id") == expected_id,
                    ppath,
                    ptr + "/qualification_build_id",
                    f"exact engine/repository/tag/ROCm/platform/artifact join requires {expected_id!r}; benchmark run IDs are separate",
                    row["source_id"],
                )
                _check(
                    attribution.get("status")
                    == ("matched" if matches else "rocm_identified"),
                    ppath,
                    ptr + "/attribution/status",
                    "attribution status must reflect exact qualification-package association",
                    row["source_id"],
                )
                group = tuple(
                    row.get(key)
                    for key in (
                        "engine",
                        "channel",
                        "model",
                        "scenario",
                        "quant",
                        "system_id",
                    )
                )
                if (
                    group not in latest_measurements
                    or instant > latest_measurements[group][0]
                ):
                    latest_measurements[group] = (instant, row)
                stable_count += (
                    row["engine"] == "llamacpp" and row["channel"] == "stable"
                )
            _check(
                system_ids == used_systems,
                ppath,
                "/systems",
                "performance file must contain exactly referenced source-scoped systems",
            )
            _check(
                _integer(performance.get("measurement_count"))
                and performance["measurement_count"] == len(measurements),
                overview_path,
                "/performance/measurement_count",
                f"count must equal {ppath} /measurements length",
            )
            expected = [
                latest_measurements[key][1]
                for key in sorted(
                    latest_measurements, key=lambda item: tuple(str(x) for x in item)
                )
            ]
            _check(
                performance.get("latest_measurements") == expected,
                overview_path,
                "/performance/latest_measurements",
                "summary must select newest measured_at per engine/channel/model/scenario/quant/system group",
            )
        else:
            _check(
                performance == {"status": "not_measured"},
                overview_path,
                "/performance",
                "unmeasured versions cannot claim performance paths or counts",
            )
        cards = sequence(overview.get("engines"), overview_path, "/engines")
        expected_engines = {row["engine"] for row in builds + measurements}
        _check(
            [card.get("id") for card in cards]
            == [engine["id"] for engine in engines if engine["id"] in expected_engines],
            overview_path,
            "/engines",
            "cards must contain only engines owning builds or measurements, in catalog order",
        )
        for cpos, card in enumerate(cards):
            ptr = f"/engines/{cpos}"
            base = engine_map[card["id"]]
            _check(
                all(card.get(key) == value for key, value in base.items()),
                overview_path,
                ptr,
                "engine metadata must agree with index catalog",
            )
            owned = [row for row in builds if row["engine"] == card["id"]]
            _check(
                _integer(card.get("build_count")) and card["build_count"] == len(owned),
                overview_path,
                ptr + "/build_count",
                "engine count must equal retained history records owned by this engine",
            )
            groups = {}
            for row in owned:
                group = tuple(row.get(key) for key in ("channel", "os", "gfx_target"))
                rank = (
                    _time(row["generated_at"], overview_path, ptr),
                    row["run_attempt"],
                    row["source_id"],
                    row["build_id"],
                )
                if group not in groups or rank > groups[group][0]:
                    groups[group] = (rank, row)
            expected = [
                groups[key][1]
                for key in sorted(groups, key=lambda item: tuple(str(x) for x in item))
            ]
            actual = sequence(
                card.get("latest_builds"), overview_path, ptr + "/latest_builds"
            )
            for pos, row in enumerate(actual):
                _check(
                    BUILD_REQUIRED <= row.keys(),
                    overview_path,
                    ptr + f"/latest_builds/{pos}",
                    "latest-build summary must retain required history fields",
                )
            _check(
                _same_records(actual, expected),
                overview_path,
                ptr + "/latest_builds",
                "latest must be maximum timestamp/attempt/source/build per channel/platform/GPU-target group from retained history",
            )
    stable = index.get("stable_performance")
    _check(
        isinstance(stable, dict)
        and type(stable.get("assigned_count")) is int
        and stable["assigned_count"] == stable_count,
        "index.json",
        "/stable_performance/assigned_count",
        "count must equal all retained stable llama.cpp measurements",
    )
    _check(
        stable.get("awaiting_evidence_count") == 0
        and type(stable["awaiting_evidence_count"]) is int,
        "index.json",
        "/stable_performance/awaiting_evidence_count",
        "unassigned observations are excluded from published performance",
    )
    if "comparison_performance" in index:
        part = index["comparison_performance"]
        cpath = "performance/comparisons.json"
        _check(
            isinstance(part, dict) and part.get("path") == cpath,
            "index.json",
            "/comparison_performance/path",
            "comparison partition must use its documented path",
        )
        data = read(cpath)
        schema(data, cpath)
        rows = sequence(data.get("measurements"), cpath, "/measurements")
        _check(
            _integer(part.get("count")) and part["count"] == len(rows),
            "index.json",
            "/comparison_performance/count",
            "comparison count must equal partition measurements length",
        )
        system_ids = validate_systems(
            sequence(data.get("systems"), cpath, "/systems"), cpath
        )
        seen, used = set(), set()
        for pos, row in enumerate(rows):
            ptr = f"/measurements/{pos}"
            _check(
                MEASUREMENT_REQUIRED <= row.keys(),
                cpath,
                ptr,
                "comparison is missing documented measurement fields",
            )
            ownership(row, cpath, ptr, measurement=True)
            for key in (
                "fork_id",
                "engine_version",
                "model",
                "scenario",
                "engine_repository",
                "channel",
                "run_url",
            ):
                _check(
                    isinstance(row.get(key), str) and row[key],
                    cpath,
                    ptr + "/" + key,
                    "expected nonempty measurement identity string",
                )
            for key in ("quant", "run_id"):
                _check(
                    row.get(key) is None or type(row[key]) in (str, int),
                    cpath,
                    ptr + "/" + key,
                    "expected nullable scalar identity",
                )
            identity = tuple(row.get(key) for key in MEASUREMENT_ID)
            _check(
                identity not in seen,
                cpath,
                ptr,
                "comparison identity must occur only once",
            )
            seen.add(identity)
            _time(row.get("measured_at"), cpath, ptr + "/measured_at")
            _check(
                row.get("backend") in ("vulkan", "hrx"),
                cpath,
                ptr + "/backend",
                "non-ROCm comparisons require Vulkan or HRX backend",
            )
            for key in (
                "rocm_version",
                "runtime_version",
                "qualification_build_id",
                "package_url",
                "package_os",
            ):
                _check(
                    row.get(key) is None,
                    cpath,
                    ptr + "/" + key,
                    "non-ROCm comparison cannot claim package or qualification attribution",
                )
            attribution = row.get("attribution")
            _check(
                attribution is None
                or isinstance(attribution, dict)
                and attribution.get("status") not in ("matched", "rocm_identified"),
                cpath,
                ptr + "/attribution",
                "comparison cannot claim verified ROCm package attribution",
            )
            if row.get("system_id") is not None:
                _check(
                    isinstance(row["system_id"], str),
                    cpath,
                    ptr + "/system_id",
                    "expected nullable source-scoped system ID",
                )
                key = (row["source_id"], row["system_id"])
                _check(
                    key in system_ids,
                    cpath,
                    ptr + "/system_id",
                    "comparison must reference its source-scoped system",
                )
                used.add(key)
            metrics = row.get("metrics")
            _check(
                isinstance(metrics, dict)
                and all(
                    value is None or _number(value) and value >= 0
                    for value in metrics.values()
                ),
                cpath,
                ptr + "/metrics",
                "comparison metrics must be finite numbers or null",
            )
            for key in ("context_size", "input_tokens"):
                _check(
                    row.get(key) is None
                    or _integer(row[key])
                    and (key != "context_size" or row[key] > 0),
                    cpath,
                    ptr + "/" + key,
                    "expected optional workload count",
                )
            run = re.fullmatch(
                r"https://github\.com/[^/]+/[^/]+/actions/runs/([0-9]+)",
                row.get("run_url") or "",
            )
            _check(
                run is not None and str(row.get("run_id")) == run[1],
                cpath,
                ptr + "/run_id",
                "comparison run ID must match benchmark workflow URL",
            )
        _check(
            system_ids == used,
            cpath,
            "/systems",
            "comparison file must contain exactly referenced systems",
        )

    def sync(value, path, prefix="/sync"):
        _check(
            isinstance(value, dict)
            and set(value)
            == {"attempted_at", "status", "last_successful_at", "errors"},
            path,
            prefix,
            "sync requires exact attempt/status/last-success/errors fields",
        )
        _time(value["attempted_at"], path, prefix + "/attempted_at")
        if value["last_successful_at"] is not None:
            _time(value["last_successful_at"], path, prefix + "/last_successful_at")
        _check(
            value["status"] in ("success", "failed"),
            path,
            prefix + "/status",
            "sync status must be success or failed",
        )
        errors = sequence(value["errors"], path, prefix + "/errors")
        _check(
            all(
                set(err) == {"source_id", "record", "field", "reason"}
                and all(isinstance(x, str) for x in err.values())
                for err in errors
            ),
            path,
            prefix + "/errors",
            "diagnostics require string source/record/field/reason",
        )
        if value["status"] == "success":
            _check(
                not errors and value["attempted_at"] == value["last_successful_at"],
                path,
                prefix,
                "successful attempts have no errors and set last_successful_at to attempted_at",
            )

    if "sync" in index:
        sync(index["sync"], "index.json")
        _check(
            index["sync"]["status"] == "success"
            and index["sync"]["attempted_at"] == index["generated_at"],
            "index.json",
            "/sync",
            "immutable successful sync must describe index collection",
        )
    live_sync = None
    if (root / "sync.json").exists():
        metadata = read("sync.json")
        schema(metadata, "sync.json", 1)
        live_sync = metadata.get("sync")
        sync(live_sync, "sync.json")
        _check(
            live_sync["last_successful_at"] == index["generated_at"],
            "sync.json",
            "/sync/last_successful_at",
            "live status must retain the successful dataset timestamp",
        )
    if check_live_pointer and (root / "latest.json").exists():
        latest = read("latest.json")
        schema(latest, "latest.json", 1)
        commit = latest.get("data_commit")
        _check(
            isinstance(commit, str) and re.fullmatch(r"[a-f0-9]{40}", commit),
            "latest.json",
            "/data_commit",
            "complete datasets require an immutable commit pointer",
        )
        url = latest.get("index_url")
        _check(
            isinstance(url, str)
            and re.fullmatch(
                r"https://raw\.githubusercontent\.com/[^/]+/[^/]+/"
                + commit
                + r"/data/index\.json",
                url,
            ),
            "latest.json",
            "/index_url",
            "index URL must point at the exact data_commit",
        )
        _check(
            "sync" in latest,
            "latest.json",
            "/sync",
            "published live pointer must include attempt status",
        )
        sync(latest["sync"], "latest.json")
        _check(
            live_sync is None or latest["sync"] == live_sync,
            "latest.json",
            "/sync",
            "live latest and live sync must describe the same attempt",
        )
    return paths


def main():
    import argparse
    import sys

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--sources", type=Path)
    args = parser.parse_args()
    try:
        config = (
            None
            if args.sources is None
            else json.loads(args.sources.read_text(encoding="utf-8"))
        )
        paths = validate_dataset(args.data_dir, config)
    except (PipelineValidationError, OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f"PASS: {len(paths)} dataset files conform")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

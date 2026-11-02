"""Read detailed, immutable benchmark execution evidence independently of metrics."""

from concurrent.futures import ThreadPoolExecutor
import copy
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from urllib.parse import quote


def _require(condition, reason):
    if not condition:
        raise ValueError(reason)


def canonical_json_sha256(value):
    encoded = json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _time(value):
    _require(isinstance(value, str), "execution timestamp is missing")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require(parsed.tzinfo is not None, "execution timestamp lacks timezone")
    return parsed


def _count(value, field):
    _require(value is None or type(value) is int and value >= 0, f"invalid {field}")
    return value


def _status(scenario, config):
    failed = _count(scenario.get("failed_runs"), "failed_runs")
    all_failed = scenario.get("all_runs_failed")
    _require(all_failed is None or type(all_failed) is bool, "invalid all_runs_failed")
    measurement_runs = _count(config.get("measurement_runs"), "measurement_runs")
    # The producer emits these objects only for a nonempty successful-run set.
    # Corroborate explicit execution fields; metrics alone never establish a pass.
    successful_statistics = []
    for field in ("tps", "duration_ms", "ttft_ms"):
        statistics = scenario.get(field)
        mean = statistics.get("mean") if isinstance(statistics, dict) else None
        successful_statistics.append(
            type(mean) in (int, float) and math.isfinite(mean) and mean >= 0
        )
    if all_failed is True:
        _require(not any(successful_statistics), "contradictory execution statistics")
        return "failed"
    if failed is None or not measurement_runs or not all(successful_statistics):
        return "unknown"
    return "passed" if failed == 0 else "partial"


def _identity(row):
    return (
        row["source_id"],
        row["fork_id"],
        row["engine"],
        row["channel"],
        row["backend"],
        row["engine_repository"],
        row["model"],
        json.dumps(row["checkpoints"], sort_keys=True, ensure_ascii=False),
        row["scenario"],
        row["context_size"],
        row["backend_args"],
        row["system_id"],
        row["quant"],
    )


def select_latest(rows, *, per_version=False, per_package=False):
    """Select latest evidence without substituting an older successful attempt."""
    selected = {}
    for row in rows:
        key = _identity(row)
        if per_version:
            _require(row.get("rocm_version"), "latest selection requires verified ROCm")
            key += (row["rocm_version"],)
        if per_package:
            key += (row["engine_version"],)
        previous = selected.get(key)
        if previous is None or _time(row["measured_at"]) > _time(
            previous["measured_at"]
        ):
            selected[key] = row
        elif _time(row["measured_at"]) == _time(previous["measured_at"]):
            ignored = {
                "source_url",
                "source_pointer",
                "source_blob_sha",
                "source_json_sha256",
            }
            _require(
                {k: v for k, v in row.items() if k not in ignored}
                == {k: v for k, v in previous.items() if k not in ignored},
                "ambiguous latest execution attempts",
            )
            if (row["source_url"], row["source_pointer"]) < (
                previous["source_url"],
                previous["source_pointer"],
            ):
                selected[key] = row
    return sorted(
        selected.values(),
        key=lambda row: tuple(str(value) for value in _identity(row))
        + (row.get("rocm_version") or "", row["engine_version"], row["measured_at"]),
    )


def _normalize(source, path, document, url, blob_sha):
    _require(isinstance(document, dict), f"{path}: expected execution document")
    _, fork_id, expected_model, _ = path.split("/")
    fork = source["forks"][fork_id]
    _require(document.get("fork_id") == fork_id, f"{path}: fork identity conflict")
    _require(
        document.get("fork_repo") == fork["repository"],
        f"{path}: repository identity conflict",
    )
    version = document.get("fork_version")
    _require(isinstance(version, str) and version, f"{path}: missing engine version")
    run_id = str(document.get("run_id") or "")
    _require(run_id.isdigit(), f"{path}: missing benchmark run identity")
    run_url = document.get("run_url")
    _require(
        run_url == f"https://github.com/{source['repository']}/actions/runs/{run_id}",
        f"{path}: benchmark run identity conflict",
    )
    hardware = document.get("hardware")
    _require(isinstance(hardware, dict), f"{path}: missing measured hardware")
    _require(
        isinstance(hardware.get("cpu"), str)
        and isinstance(hardware.get("os"), str)
        and isinstance(hardware.get("gpu"), list),
        f"{path}: incomplete measured hardware identity",
    )
    physical = {
        key: value
        for key, value in hardware.items()
        if key not in ("backends", "lemonade_version")
    }
    system_id = "hardware-" + canonical_json_sha256(physical)
    digest = canonical_json_sha256(document)
    models = document.get("models")
    if models is None:
        models = [document]
    _require(isinstance(models, list) and models, f"{path}: missing model records")
    attempts = []
    for mi, model in enumerate(models):
        _require(isinstance(model, dict), f"{path}: invalid model record")
        _require(
            model.get("model") == expected_model, f"{path}: model identity conflict"
        )
        model_ptr = f"/models/{mi}" if "models" in document else ""
        measured_at = model.get("timestamp", document.get("timestamp"))
        _time(measured_at)
        checkpoints = model.get("checkpoints")
        _require(
            checkpoints is None
            or isinstance(checkpoints, dict)
            and all(isinstance(v, str) for v in checkpoints.values()),
            f"{path}: invalid checkpoints",
        )
        config = model.get("config") or {}
        _require(isinstance(config, dict), f"{path}: invalid execution configuration")
        quant = model.get("quant")
        _require(
            quant is None or isinstance(quant, str), f"{path}: invalid quantization"
        )
        results = model.get("results")
        _require(isinstance(results, list), f"{path}: missing backend results")
        for bi, backend in enumerate(results):
            _require(isinstance(backend, dict), f"{path}: invalid backend result")
            if (
                backend.get("backend") != fork["backend"]
                or backend.get("recipe") != fork["engine"]
            ):
                continue
            context = backend.get("ctx_size")
            _require(
                type(context) is int and context > 0, f"{path}: invalid context size"
            )
            arguments = backend.get("backend_args")
            _require(
                arguments is None or isinstance(arguments, str),
                f"{path}: invalid backend arguments",
            )
            scenarios = backend.get("scenarios")
            _require(isinstance(scenarios, list), f"{path}: missing scenarios")
            for si, scenario in enumerate(scenarios):
                _require(isinstance(scenario, dict), f"{path}: invalid scenario")
                name = scenario.get("name")
                _require(
                    isinstance(name, str) and name, f"{path}: missing scenario name"
                )
                status = _status(scenario, config)
                attempts.append(
                    {
                        "source_id": source["id"],
                        "source_url": url,
                        "source_pointer": f"{model_ptr}/results/{bi}/scenarios/{si}",
                        "source_blob_sha": blob_sha,
                        "source_json_sha256": digest,
                        "engine": fork["engine"],
                        "channel": fork["channel"],
                        "backend": fork["backend"],
                        "fork_id": fork_id,
                        "engine_repository": fork["repository"],
                        "engine_version": version,
                        "model": expected_model,
                        "scenario": name,
                        "quant": quant,
                        "checkpoints": copy.deepcopy(checkpoints),
                        "system_id": system_id,
                        "hardware": copy.deepcopy(physical),
                        "context_size": context,
                        "backend_args": arguments,
                        "input_tokens": _count(
                            scenario.get("input_tokens"), "input_tokens"
                        ),
                        "output_tokens": _count(
                            scenario.get("output_tokens"), "output_tokens"
                        ),
                        "measured_at": measured_at,
                        "run_id": run_id,
                        "run_url": run_url,
                        "lemonade_version": document.get("lemonade_version"),
                        "producer_rocm_version": document.get("rocm_version"),
                        "rocm_version": None,
                        "qualification_build_id": None,
                        "execution_status": status,
                        "failed_runs": _count(
                            scenario.get("failed_runs"), "failed_runs"
                        ),
                        "all_runs_failed": scenario.get("all_runs_failed"),
                        "measurement_runs": _count(
                            config.get("measurement_runs"), "measurement_runs"
                        ),
                        "warmup_runs": _count(config.get("warmup_runs"), "warmup_runs"),
                    }
                )
    return attempts


def collect_executions(source, commit, fetch, *, cache_dir=None):
    """Discover every stable raw report and retain latest execution candidates."""
    _require(re.fullmatch(r"[a-f0-9]{40}", commit or ""), "invalid source commit")
    repository = source["repository"]
    _require(
        re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
        "invalid source repository",
    )
    selected = source.get("include_forks", source["forks"])
    forks = {
        key
        for key in selected
        if source["forks"][key]["engine"] == "llamacpp"
        and source["forks"][key]["channel"] == "stable"
        and source["forks"][key]["backend"] == "rocm"
    }
    tree_url = (
        f"https://api.github.com/repos/{repository}/git/trees/{commit}?recursive=1"
    )
    tree = fetch(tree_url)
    _require(
        isinstance(tree, dict) and tree.get("truncated") is False,
        "execution inventory is truncated or unsupported",
    )
    _require(isinstance(tree.get("tree"), list), "missing execution inventory")
    files = {}
    for entry in tree["tree"]:
        _require(isinstance(entry, dict), "invalid execution inventory entry")
        path = entry.get("path", "")
        if entry.get("type") != "blob" or not any(
            path.startswith(f"results/{fork}/") for fork in forks
        ):
            continue
        if (
            not path.endswith(".json")
            or "/run-" not in path
            or "regression" in path.rsplit("/", 1)[-1]
        ):
            continue
        match = re.fullmatch(
            r"results/([^/]+)/([A-Za-z0-9][A-Za-z0-9_.+-]*)/run-[0-9]{8}T[0-9]{6}Z\.json",
            path,
        )
        _require(
            match is not None and match[1] in forks, "invalid execution inventory path"
        )
        sha = entry.get("sha")
        _require(
            isinstance(sha, str) and re.fullmatch(r"[a-f0-9]{40}", sha),
            "invalid source blob identity",
        )
        _require(path not in files, "duplicate execution inventory path")
        files[path] = sha
    _require(files, "empty execution inventory for enabled stable source")
    cache = Path(cache_dir) if cache_dir is not None else None
    if cache is not None:
        cache.mkdir(parents=True, exist_ok=True)

    def load(item):
        path, sha = item
        url = f"https://raw.githubusercontent.com/{repository}/{commit}/{quote(path, safe='/')}"
        cached = cache / f"{sha}.json" if cache is not None else None
        document = None
        if cached is not None and cached.exists():
            data = json.loads(cached.read_text(encoding="utf-8"))
            _require(
                data.get("blob_sha") == sha
                and data.get("json_sha256")
                == canonical_json_sha256(data.get("document")),
                "corrupt immutable execution cache",
            )
            document = data["document"]
        if document is None:
            document = fetch(url)
            if cached is not None:
                data = {
                    "blob_sha": sha,
                    "json_sha256": canonical_json_sha256(document),
                    "document": document,
                }
                with NamedTemporaryFile(
                    mode="w",
                    dir=cache,
                    prefix=sha,
                    suffix=".tmp",
                    encoding="utf-8",
                    delete=False,
                ) as handle:
                    temporary = Path(handle.name)
                    json.dump(data, handle, ensure_ascii=False, allow_nan=False)
                try:
                    temporary.replace(cached)
                finally:
                    temporary.unlink(missing_ok=True)
        return path, sha, url, document

    all_attempts = []
    documents = {}
    inventory = []
    with ThreadPoolExecutor(max_workers=8) as executor:
        for path, sha, url, document in executor.map(load, sorted(files.items())):
            rows = _normalize(source, path, document, url, sha)
            all_attempts.extend(rows)
            documents[url] = document
            inventory.append(
                {
                    "path": path,
                    "blob_sha": sha,
                    "json_sha256": canonical_json_sha256(document),
                }
            )
    attempts = select_latest(all_attempts)
    candidates = all_attempts
    urls = {row["source_url"] for row in candidates}
    return {
        "attempts": attempts,
        "candidates": candidates,
        "snapshots": {url: documents[url] for url in sorted(urls)},
        "inventory": {
            "url": tree_url,
            "commit": commit,
            "json_sha256": canonical_json_sha256(tree),
            "file_count": len(files),
            "selected_count": len(attempts),
            "candidate_count": len(candidates),
            "files": inventory,
        },
    }

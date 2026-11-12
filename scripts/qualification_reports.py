"""Prepare pinned qualification reports for display during downstream collection."""

import copy
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor

PINNED_REPORT = re.compile(
    r"https://raw\.githubusercontent\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/"
    r"[a-f0-9]{40}/qualification/reports/[A-Za-z0-9][A-Za-z0-9_.-]*\.json"
)
CHECK_ID = re.compile(r"T\d+(?:\.\d+)*")
GPU_BUFFER = re.compile(r"(?:ROCm|HIP|CUDA|Vulkan|SYCL)\d+|Metal", re.I)


def _summary(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    if isinstance(value, list):
        return ", ".join(filter(None, (_summary(item) for item in value))) or None
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _display_evidence(test):
    details = test.get("details")
    details = details if isinstance(details, dict) else {}

    def field(key):
        value = test.get(key)
        return details.get(key) if value is None else value

    entries = []
    for key, label in [("compatibility", "Compatibility"), ("runtime", "Runtime")]:
        value = _summary(field(key))
        if value:
            entries.append({"label": label, "value": value})

    proof = field("gpu_proof")
    proof = (
        [line for line in proof if isinstance(line, str) and line]
        if isinstance(proof, list)
        else []
    )
    devices = field("devices_selected")
    devices = devices if isinstance(devices, list) else []
    names = {
        item["device"]: item.get("name")
        for item in devices
        if isinstance(item, dict) and isinstance(item.get("device"), str)
    }
    buffers = field("model_buffers_mib")
    buffers = buffers if isinstance(buffers, list) else []
    rendered = []
    for item in buffers:
        if not isinstance(item, list) or len(item) != 2:
            continue
        device, size = item
        if (
            not isinstance(device, str)
            or not GPU_BUFFER.fullmatch(device)
            or type(size) not in (int, float)
            or not math.isfinite(size)
            or size <= 0
        ):
            continue
        name = names.get(device)
        label = f"{device} ({name})" if isinstance(name, str) and name else device
        rendered.append(f"{label}: {size} MiB model buffer")
    # gpu_proof is producer-authored execution evidence. The requested layer
    # count is only an instruction to the runtime and stays in raw audit details.
    value = _summary(proof) or _summary(rendered)
    if value:
        entries.append({"label": "GPU offload", "value": value})
    return entries


def prepare_report(raw):
    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("build"), dict)
        or not isinstance(raw.get("tiers"), dict)
    ):
        raise ValueError("Qualification report is missing build or tier evidence")
    result = copy.deepcopy(raw)
    for tier in result["tiers"].values():
        if not isinstance(tier, dict) or not isinstance(tier.get("tests"), list):
            continue
        tests = []
        for index, test in enumerate(tier["tests"]):
            if not isinstance(test, dict):
                continue
            test["source_index"] = index
            test["display_evidence"] = _display_evidence(test)
            tests.append(test)

        def order(test):
            identifier = test.get("id")
            if isinstance(identifier, str) and CHECK_ID.fullmatch(identifier):
                return (0, tuple(map(int, identifier[1:].split("."))))
            return (1, ())

        tier["tests"] = sorted(tests, key=order)
    return result


def collect_reports(builds, source_ids, fetch):
    """Fetch each immutable report once; failures remain visible per build.

    Limit concurrent requests so an initial snapshot can fit the collection CI
    budget without overwhelming the public producer endpoint.
    """
    urls = list(
        dict.fromkeys(
            row["report_url"] for row in builds if row["source_id"] in source_ids
        )
    )

    def snapshot(url):
        try:
            if not isinstance(url, str) or not PINNED_REPORT.fullmatch(url):
                raise ValueError("Qualification report URL is not pinned")
            return {"source_url": url, "report": prepare_report(fetch(url))}
        except (OSError, ValueError, KeyError, TypeError) as error:
            return {"source_url": url, "error": str(error)}

    with ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = dict(zip(urls, pool.map(snapshot, urls)))
    for row in builds:
        if row["source_id"] in source_ids:
            row["report_snapshot"] = snapshots[row["report_url"]]

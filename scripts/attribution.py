"""Associate stable measurements with packages recorded by benchmark jobs."""

from datetime import datetime
import copy
import hashlib
import json
import re
import subprocess

PACKAGE = re.compile(
    r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/releases/download/"
    r"(b[0-9]+)/llama-\2-bin-(ubuntu|win)-rocm-([0-9]+(?:\.[0-9]+)*)-x64\.(tar\.gz|zip)"
)
RUN = re.compile(
    r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/actions/runs/([0-9]+)"
)


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _time(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _require(parsed.tzinfo is not None, "missing evidence timezone")
    return parsed


def validate_evidence(row):
    _require(isinstance(row, dict), "invalid package evidence")
    package = PACKAGE.fullmatch(row.get("package_url", ""))
    _require(package is not None, "invalid stable package URL")
    _require(
        package[1] == row.get("engine_repository")
        and package[2] == row.get("engine_version"),
        "package identity mismatch",
    )
    _require(
        bool(
            re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", row.get("repository", ""))
        ),
        "invalid evidence repository",
    )
    _require(
        all(
            isinstance(row.get(key), str) and row[key].isdigit()
            for key in ("run_id", "job_id")
        ),
        "invalid evidence run or job",
    )
    _require(
        row.get("evidence_url")
        == f'https://github.com/{row["repository"]}/actions/runs/{row["run_id"]}/job/{row["job_id"]}',
        "invalid evidence URL",
    )
    _require(
        bool(re.fullmatch(r"[a-f0-9]{64}", row.get("log_sha256", ""))),
        "invalid log checksum",
    )
    _require(
        isinstance(row.get("fork_id"), str) and row["fork_id"], "missing evidence fork"
    )
    _require(
        _time(row["started_at"]) <= _time(row["completed_at"]),
        "invalid evidence time interval",
    )
    if row.get("scope") == "all_available_attempts":
        times = row.get("measurement_times")
        _require(
            isinstance(times, list) and times, "missing observed measurement times"
        )
        for value in times:
            _time(value)
        jobs = row.get("job_evidence")
        _require(isinstance(jobs, list) and jobs, "missing all-attempt evidence")
        seen = set()
        for job in jobs:
            _require(isinstance(job, dict), "invalid job evidence")
            _require(
                job.get("package_url") == row["package_url"],
                "conflicting attempt package",
            )
            _require(
                isinstance(job.get("job_id"), str)
                and job["job_id"].isdigit()
                and job["job_id"] not in seen,
                "invalid attempt job",
            )
            seen.add(job["job_id"])
            _require(
                job.get("evidence_url")
                == f'https://github.com/{row["repository"]}/actions/runs/{row["run_id"]}/job/{job["job_id"]}',
                "invalid attempt evidence URL",
            )
            _require(
                bool(re.fullmatch(r"[a-f0-9]{64}", job.get("log_sha256", ""))),
                "invalid attempt checksum",
            )
        _require(row["job_id"] in seen, "missing representative job")
    return package


def _matches(row, evidence):
    run = RUN.fullmatch(row.get("run_url", ""))
    return (
        run is not None
        and run[1] == evidence["repository"]
        and str(row.get("run_id")) == run[2] == evidence["run_id"]
        and row.get("fork_id") == evidence["fork_id"]
        and row.get("engine_repository") == evidence["engine_repository"]
        and row.get("engine_version") == evidence["engine_version"]
        and (
            row["measured_at"] in evidence["measurement_times"]
            if evidence.get("scope") == "all_available_attempts"
            else _time(evidence["started_at"])
            <= _time(row["measured_at"])
            <= _time(evidence["completed_at"])
        )
    )


def _gh(args):
    process = subprocess.run(
        ["gh", *args], capture_output=True, text=True, timeout=60, check=False
    )
    if process.returncode:
        raise OSError(
            "benchmark job evidence unavailable; authenticated GitHub log access may be required"
        )
    _require(
        len(process.stdout.encode()) <= 32 * 1024 * 1024, "job evidence exceeds 32 MiB"
    )
    return process.stdout


def resolve_package(row, run=_gh):
    benchmark = RUN.fullmatch(row.get("run_url", ""))
    _require(
        benchmark is not None and benchmark[2] == str(row.get("run_id")),
        "invalid benchmark run identity",
    )
    repo, run_id = benchmark.groups()
    pages = json.loads(
        run(
            [
                "api",
                f"repos/{repo}/actions/runs/{run_id}/jobs?filter=all&per_page=100",
                "--paginate",
                "--slurp",
            ]
        )
    )
    jobs = [
        job
        for page in pages
        for job in page["jobs"]
        if (
            job.get("name") == f'Bench {row["fork_id"]}'
            or re.fullmatch(r"Bench group-[0-9]+", job.get("name", ""))
        )
        and job.get("started_at")
        and job.get("completed_at")
    ]
    _require(jobs, "benchmark job identity is missing")
    job_evidence = []
    for job in jobs:
        log = run(
            ["run", "view", run_id, "--repo", repo, "--job", str(job["id"]), "--log"]
        )
        urls = set(re.findall(r"\bDownloading\s+(https://github\.com/[^\s]+)", log))
        candidates = [
            url
            for url in urls
            if (match := PACKAGE.fullmatch(url))
            and match[1] == row["engine_repository"]
        ]
        _require(
            len(candidates) == 1,
            "exact downloaded stable package is missing or ambiguous",
        )
        job_evidence.append(
            {
                "job_id": str(job["id"]),
                "package_url": candidates[0],
                "evidence_url": f'https://github.com/{repo}/actions/runs/{run_id}/job/{job["id"]}',
                "log_sha256": hashlib.sha256(log.encode()).hexdigest(),
            }
        )
    _require(
        len({item["package_url"] for item in job_evidence}) == 1,
        "package identity across attempts is ambiguous",
    )
    job = jobs[0]
    representative = job_evidence[0]
    record = {
        "repository": repo,
        "run_id": run_id,
        "job_id": str(job["id"]),
        "fork_id": row["fork_id"],
        "engine_repository": row["engine_repository"],
        "engine_version": row["engine_version"],
        "package_url": representative["package_url"],
        "started_at": job["started_at"],
        "completed_at": job["completed_at"],
        "evidence_url": f'https://github.com/{repo}/actions/runs/{run_id}/job/{job["id"]}',
        "log_sha256": representative["log_sha256"],
        "scope": "all_available_attempts",
        "job_evidence": job_evidence,
        "measurement_times": [row["measured_at"]],
    }
    validate_evidence(record)
    _require(
        _matches(row, record), "download evidence does not identify this measurement"
    )
    return record


def attribute_stable(output, evidence, resolve=None):
    _require(isinstance(evidence, list), "package evidence must be an array")
    records = []
    identities = {}

    def store(original):
        item = copy.deepcopy(original)
        validate_evidence(item)
        all_attempts = item.get("scope") == "all_available_attempts"
        key = (
            item["repository"],
            item["run_id"],
            item["fork_id"],
            item["engine_repository"],
            item["engine_version"],
            "all" if all_attempts else item["job_id"],
        )
        if key not in identities:
            identities[key] = item
            records.append(item)
            return item
        previous = identities[key]
        _require(
            previous["package_url"] == item["package_url"],
            "conflicting package evidence",
        )
        if not all_attempts:
            _require(previous == item, "conflicting job evidence")
            return previous
        jobs = {job["job_id"]: job for job in previous["job_evidence"]}
        for job in item["job_evidence"]:
            _require(
                job["job_id"] not in jobs or jobs[job["job_id"]] == job,
                "conflicting job evidence",
            )
            jobs[job["job_id"]] = job
        previous["job_evidence"] = sorted(
            jobs.values(), key=lambda job: int(job["job_id"])
        )
        representative = previous["job_evidence"][0]
        for field in ("job_id", "evidence_url", "log_sha256"):
            previous[field] = representative[field]
        previous["started_at"] = min(
            previous["started_at"], item["started_at"], key=_time
        )
        previous["completed_at"] = max(
            previous["completed_at"], item["completed_at"], key=_time
        )
        previous["measurement_times"] = sorted(
            set(previous["measurement_times"] + item["measurement_times"])
        )
        return previous

    for item in evidence:
        store(item)
    failures = {}
    resolved = {}
    for row in output["measurements"]:
        if not (
            row["engine"] == "llamacpp"
            and row["channel"] == "stable"
            and row["backend"] == "rocm"
        ):
            continue
        key = (row.get("run_url"), row.get("engine_version"), row.get("fork_id"))
        fresh = resolved.get(key)
        if fresh is not None and fresh.get("scope") == "all_available_attempts":
            trial = {**fresh, "measurement_times": [row["measured_at"]]}
            if (
                _matches(row, trial)
                and row["measured_at"] not in fresh["measurement_times"]
            ):
                fresh["measurement_times"].append(row["measured_at"])
        candidates = [item for item in records if _matches(row, item)]
        _require(len(candidates) <= 1, "conflicting measurement package evidence")
        key = (row.get("run_url"), row.get("engine_version"), row.get("fork_id"))
        reason = failures.get(key, "exact package evidence has not been collected")
        if not candidates and resolve is not None and key not in failures:
            try:
                item = resolve(row)
                validate_evidence(item)
                _require(
                    _matches(row, item), "resolved evidence does not match measurement"
                )
                item = store(item)
                resolved[key] = item
                candidates = [item]
            except (
                OSError,
                ValueError,
                KeyError,
                TypeError,
                subprocess.TimeoutExpired,
            ):
                reason = "exact package evidence unavailable; retry with authenticated benchmark log access"
                failures[key] = reason
        if not candidates:
            row["attribution"] = {"status": "awaiting_evidence", "reason": reason}
            continue
        item = candidates[0]
        package = validate_evidence(item)
        row.update(
            rocm_version=package[4],
            package_url=item["package_url"],
            package_os={"ubuntu": "linux", "win": "windows"}[package[3]],
            attribution={
                "status": "rocm_identified",
                "evidence_url": item["evidence_url"],
                "log_sha256": item["log_sha256"],
                "package_url": item["package_url"],
            },
        )
    output["package_evidence"] = records

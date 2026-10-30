"""Collect upstream projects' own Radeon and Ryzen AI CI for the Upstream health view.

The readiness dataset answers "how ready is ROCm <version>" from fork and
qualification feeds. This module answers a different question from a different
place: how healthy is Radeon and Ryzen AI support in each project as it ships,
read from the project's own GitHub Actions on its default branch.

Inputs come from ``projects.json``. For each project it names the workflows and
jobs that exercise client AMD hardware or build for it, the forks that carry AMD
work, and what the project ships per operating system.

Outputs go under ``upstream/`` in the dataset:

``upstream/overview.json``
    One card per project: headline numbers, the computed upstream badge, forks,
    platform coverage, findings, and per-job daily aggregates for the window.
``upstream/<project>/ci/YYYY-MM.json``
    Every retained job execution on the default branch, with its result, first
    failing step, queue wait, links, and, for pushes, what the job said on the
    pull request commit that was merged.

Collection is incremental and budgeted. Runs already recorded as complete in the
previous dataset are reused without another API call, and a call budget caps a
single collection so a scheduled run stays inside the GITHUB_TOKEN rate limit.
When the budget runs out the newest runs are kept and coverage says so.

Rules carried over from the investigation that produced this view:

* Only the default branch counts. Pull request runs, and PyTorch's
  ``ciflow/<workflow>/<PR>`` tag pushes, are a contributor iterating, not what
  shipped. Release tags count only when a project opts in with ``tag_pattern``.
* A job is judged by its own conclusion, never the workflow's.
* A job with no steps never reached a machine. Skipped means its own condition
  switched it off; anything else is "requested, never ran".
* Merge verdicts are read from the check runs on the pull request's final head
  commit, not from the workflow-run list, which is capped and eventually
  consistent.
* The upstream badge is green only when a test on main ran on a gfx1151 or
  gfx1201 GPU, amber when other client hardware was tested, red otherwise.
"""

from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path, PurePosixPath
import re
from statistics import median
from urllib.error import HTTPError
from urllib.parse import quote

if __package__:
    from .validation import PipelineValidationError
else:
    from validation import PipelineValidationError

SCHEMA_VERSION = 1
CATEGORIES = ("tests", "builds", "nightlies", "releases")
STACKS = ("rocm", "vulkan", "npu")
OSES = ("linux", "windows")
STATES = ("passed", "failed", "other", "stalled", "skipped", "running")
API = "https://api.github.com"
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
PROJECT_ID = re.compile(r"[a-z0-9][a-z0-9-]*")
SLOW_QUEUE_SECONDS = 600
MAX_RUN_PAGES = 10


def _require(condition, record, field, reason):
    if not condition:
        raise PipelineValidationError("upstream", record, field, reason)


def _time(value):
    if not isinstance(value, str) or not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else None


def _iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- configuration ------------------------------------------------------------


def validate_projects(config):
    """Check projects.json before any network call."""
    _require(isinstance(config, dict), "projects.json", "/", "expected object")
    _require(
        config.get("schema_version") == 1,
        "projects.json",
        "/schema_version",
        "unsupported projects schema_version",
    )
    window = config.get("window_days")
    _require(
        type(window) is int and 1 <= window <= 90,
        "projects.json",
        "/window_days",
        "window_days must be an integer from 1 to 90",
    )
    rule = config.get("client_rule")
    _require(
        isinstance(rule, dict)
        and isinstance(rule.get("targets"), list)
        and rule["targets"]
        and all(isinstance(t, str) and t.startswith("gfx") for t in rule["targets"]),
        "projects.json",
        "/client_rule/targets",
        "client_rule.targets must list gfx targets",
    )
    projects = config.get("projects")
    _require(
        isinstance(projects, list) and projects,
        "projects.json",
        "/projects",
        "expected a nonempty project list",
    )
    seen = set()
    for pos, project in enumerate(projects):
        where = f"/projects/{pos}"
        _require(isinstance(project, dict), "projects.json", where, "expected object")
        pid = project.get("id")
        _require(
            isinstance(pid, str) and PROJECT_ID.fullmatch(pid) is not None,
            "projects.json",
            where + "/id",
            "invalid project id",
        )
        _require(
            pid not in seen, "projects.json", where + "/id", "duplicate project id"
        )
        seen.add(pid)
        _require(
            isinstance(project.get("label"), str) and project["label"],
            "projects.json",
            where + "/label",
            "missing label",
        )
        _require(
            isinstance(project.get("repository"), str)
            and REPOSITORY.fullmatch(project["repository"]) is not None,
            "projects.json",
            where + "/repository",
            "invalid repository",
        )
        _require(
            isinstance(project.get("default_branch"), str)
            and project["default_branch"],
            "projects.json",
            where + "/default_branch",
            "missing default branch",
        )
        if "note" in project:
            _require(
                isinstance(project["note"], str),
                "projects.json",
                where + "/note",
                "note must be text",
            )
        if "tag_pattern" in project:
            try:
                re.compile(project["tag_pattern"])
            except (re.error, TypeError) as error:
                _require(False, "projects.json", where + "/tag_pattern", str(error))
        for fpos, fork in enumerate(project.get("forks", [])):
            _require(
                isinstance(fork, dict)
                and isinstance(fork.get("repository"), str)
                and REPOSITORY.fullmatch(fork["repository"]) is not None
                and isinstance(fork.get("role"), str),
                "projects.json",
                f"{where}/forks/{fpos}",
                "fork needs a repository and a role",
            )
            if "channel" in fork:
                _require(
                    fork["channel"] in ("stable", "nightly", "preview"),
                    "projects.json",
                    f"{where}/forks/{fpos}/channel",
                    "invalid fork channel",
                )
        ships = project.get("ships", {})
        _require(
            isinstance(ships, dict)
            and all(k in OSES and isinstance(v, str) for k, v in ships.items()),
            "projects.json",
            where + "/ships",
            "ships maps linux/windows to a description",
        )
        job_ids = set()
        for jpos, job in enumerate(project.get("jobs", [])):
            jwhere = f"{where}/jobs/{jpos}"
            _require(isinstance(job, dict), "projects.json", jwhere, "expected object")
            _require(
                isinstance(job.get("id"), str)
                and PROJECT_ID.fullmatch(job["id"]) is not None
                and job["id"] not in job_ids,
                "projects.json",
                jwhere + "/id",
                "job ids must be unique slugs",
            )
            job_ids.add(job["id"])
            for field in ("label", "workflow", "where", "cadence"):
                _require(
                    isinstance(job.get(field), str) and job[field],
                    "projects.json",
                    f"{jwhere}/{field}",
                    f"missing {field}",
                )
            _require(
                job["workflow"].endswith((".yml", ".yaml"))
                and "/" not in job["workflow"],
                "projects.json",
                jwhere + "/workflow",
                "workflow must be a file name",
            )
            _require(
                job.get("category") in CATEGORIES,
                "projects.json",
                jwhere + "/category",
                "invalid category",
            )
            _require(
                job.get("stack") in STACKS,
                "projects.json",
                jwhere + "/stack",
                "invalid stack",
            )
            _require(
                job.get("os") in OSES, "projects.json", jwhere + "/os", "invalid os"
            )
            _require(
                isinstance(job.get("target"), str) and job["target"],
                "projects.json",
                jwhere + "/target",
                "missing target",
            )
            try:
                matcher(job.get("match"))
            except (ValueError, re.error, TypeError) as error:
                _require(False, "projects.json", jwhere + "/match", str(error))
    return config


def matcher(spec):
    """Build a job-name predicate from {"name"}, {"prefix"} or {"regex"}."""
    if not isinstance(spec, dict) or len(spec) != 1:
        raise ValueError("match needs exactly one of name, prefix or regex")
    ((kind, value),) = spec.items()
    if not isinstance(value, str) or not value:
        raise ValueError("match value must be a nonempty string")
    if kind == "name":
        return lambda name: name == value
    if kind == "prefix":
        return lambda name: name.startswith(value)
    if kind == "regex":
        pattern = re.compile(value)
        return lambda name: pattern.search(name) is not None
    raise ValueError(f"unknown match kind {kind}")


# ---- GitHub reads ---------------------------------------------------------------


class Budget:
    """Caps API calls in one collection so a scheduled run stays in its rate
    limit. Every read charges it, from any thread."""

    def __init__(self, calls):
        self.limit = calls
        self.used = 0
        self._lock = Lock()

    @property
    def exhausted(self):
        return self.used >= self.limit

    def take(self):
        with self._lock:
            if self.used >= self.limit:
                return False
            self.used += 1
            return True


class OutOfBudget(Exception):
    pass


def _get(fetch, budget, url):
    if not budget.take():
        raise OutOfBudget(url)
    return fetch(url)


def _parallel(items, work, workers):
    """Run ``work`` over ``items`` on a small thread pool, keeping input order.

    GitHub reads are latency bound, so this is the difference between seconds
    and minutes. One failed read (a timeout, a rate limit, an empty budget)
    costs that item, not the whole project: it comes back as None and the
    caller treats the item as not read yet."""
    if not items:
        return []
    failures = []

    def guarded(item):
        try:
            return work(item)
        except (OSError, ValueError, KeyError, TypeError, OutOfBudget) as error:
            failures.append(f"{type(error).__name__}: {error}")
            return None

    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(items)))) as pool:
        results = list(pool.map(guarded, items))
    if failures:
        print(
            f"  {len(failures)} reads failed, will retry next run: {failures[0]}",
            flush=True,
        )
    return results


def _pages(fetch, budget, url, key, workers, cap):
    """Read a paged list. The first page gives ``total_count``; the rest are
    read side by side. Returns (items, truncated) where truncated means the
    list was longer than ``cap`` pages."""
    sep = "&" if "?" in url else "?"
    first = _get(fetch, budget, f"{url}{sep}per_page=100&page=1")
    items = list(first.get(key) or [])
    total = first.get("total_count") or len(items)
    pages = list(range(2, min(cap, -(-total // 100)) + 1))
    for data in _parallel(
        pages,
        lambda p: _get(fetch, budget, f"{url}{sep}per_page=100&page={p}"),
        workers,
    ):
        if data is None:
            raise OSError(f"a page of {url} could not be read")
        items.extend(data.get(key) or [])
    return items, total > cap * 100


def _runs(fetch, budget, repo, workflow, query, start, end, workers):
    """Workflow runs created from ``start`` to ``end`` (dates), newest first.

    GitHub stops a run list at 1000. A busy repository can pass that within a
    30 day window, so an over-long range is split in two and read again,
    rather than silently losing its oldest runs."""
    span = f"{start.isoformat()}..{end.isoformat()}"
    url = (
        f"{API}/repos/{repo}/actions/workflows/{quote(workflow)}/runs"
        f"?exclude_pull_requests=true&{query}&created={span}"
    )
    runs, truncated = _pages(
        fetch, budget, url, "workflow_runs", workers, MAX_RUN_PAGES
    )
    if truncated and start < end:
        middle = start + (end - start) // 2
        newer, t1 = _runs(
            fetch,
            budget,
            repo,
            workflow,
            query,
            middle + timedelta(days=1),
            end,
            workers,
        )
        older, t2 = _runs(fetch, budget, repo, workflow, query, start, middle, workers)
        return newer + older, t1 or t2
    return runs, truncated


def _listed_runs(fetch, budget, project, workflow, since, now, workers):
    query = "branch=" + quote(project["default_branch"], safe="")
    runs, truncated = _runs(
        fetch,
        budget,
        project["repository"],
        workflow,
        query,
        since.date(),
        now.date(),
        workers,
    )
    if project.get("tag_pattern"):
        seen = {r["id"] for r in runs}
        tagged, more = _runs(
            fetch,
            budget,
            project["repository"],
            workflow,
            "event=push",
            since.date(),
            now.date(),
            workers,
        )
        runs += [r for r in tagged if r["id"] not in seen]
        truncated = truncated or more
    return [r for r in runs if _keep_run(r, project)], truncated


def _keep_run(run, project):
    """Default-branch work only, plus opted-in release tags."""
    event = run.get("event") or ""
    ref = run.get("head_branch") or ""
    if event.startswith("pull_request") or ref.startswith("ciflow/"):
        return False
    if ref == project["default_branch"]:
        return True
    pattern = project.get("tag_pattern")
    return bool(pattern and event == "push" and re.match(pattern, ref))


def _scan_key(run):
    """A run is scanned per attempt, so a re-run is read again."""
    return f"{run['id']}#{run.get('run_attempt') or 1}@{(run.get('created_at') or '')[:10]}"


def _scan_day(key):
    return key.rpartition("@")[2]


def _state(job):
    started = bool(job.get("steps"))
    conclusion = job.get("conclusion")
    if job.get("status") != "completed":
        return "running" if started else "stalled"
    if not started:
        return "skipped" if conclusion == "skipped" else "stalled"
    if conclusion == "success":
        return "passed"
    if conclusion == "failure":
        return "failed"
    return "other"


def _record(run, job, spec):
    created = _time(job.get("created_at")) or _time(run.get("created_at"))
    started = _time(job.get("started_at"))
    state = _state(job)
    queue = None
    if state not in ("stalled", "skipped") and created and started:
        seconds = int((started - created).total_seconds())
        # Re-run bookkeeping can put created after started; drop, never clamp.
        queue = seconds if seconds >= 0 else None
    failed = next(
        (
            s.get("name")
            for s in job.get("steps") or []
            if s.get("conclusion") == "failure"
        ),
        None,
    )
    return {
        "job": spec["id"],
        "run_id": str(run["id"]),
        "job_id": str(job["id"]),
        "attempt": run.get("run_attempt") or 1,
        "day": (run.get("created_at") or "")[:10],
        "created_at": run.get("created_at"),
        "event": run.get("event"),
        "ref": run.get("head_branch"),
        "sha": run.get("head_sha"),
        "status": job.get("status"),
        "conclusion": job.get("conclusion"),
        "state": state,
        "failed_step": failed,
        "queue_seconds": queue,
        "runner": job.get("runner_name") or None,
        "url": job.get("html_url") or run.get("html_url"),
    }


def _merged_pr(fetch, budget, repo, sha, branch):
    """The pull request that put ``sha`` on the default branch, if any."""
    data = _get(fetch, budget, f"{API}/repos/{repo}/commits/{sha}/pulls")
    pr = next(
        (
            p
            for p in (data if isinstance(data, list) else [])
            if p.get("merged_at") and (p.get("base") or {}).get("ref") == branch
        ),
        None,
    )
    if pr is None:
        return None
    return {
        "number": pr["number"],
        "url": pr["html_url"],
        "head_sha": pr["head"]["sha"],
        "author": (pr.get("user") or {}).get("login"),
        "merged_at": pr.get("merged_at"),
    }


def _check_runs(fetch, budget, repo, sha, workers):
    """Every check run on a commit, and whether the list was cut short."""
    rows, truncated = _pages(
        fetch,
        budget,
        f"{API}/repos/{repo}/commits/{sha}/check-runs",
        "check_runs",
        workers,
        10,
    )
    return {
        "truncated": truncated,
        "runs": [
            {
                "name": c.get("name") or "",
                "conclusion": c.get("conclusion"),
                "started_at": c.get("started_at") or "",
                "url": c.get("html_url"),
            }
            for c in rows
        ],
    }


def _verdict(checks, match):
    """What a job said on a pull request's final commit.

    Matrix jobs (shards, architectures) match several check names; the newest
    attempt of each counts, and one failing shard makes the verdict failed."""
    latest = {}
    for c in checks["runs"]:
        if match(c["name"]) and c["started_at"] >= latest.get(c["name"], {}).get(
            "started_at", ""
        ):
            latest[c["name"]] = c
    if not latest:
        # A cut-off check list cannot prove the job never ran.
        return ("no_result" if checks["truncated"] else "not_triggered"), None
    runs = sorted(latest.values(), key=lambda c: c["started_at"])
    failed = [c for c in runs if c["conclusion"] == "failure"]
    if failed:
        return "failed", failed[-1]["url"]
    if all(c["conclusion"] == "success" for c in runs):
        return "passed", runs[-1]["url"]
    return "no_result", runs[-1]["url"]


# ---- previous data -------------------------------------------------------------------


def _safe_relative(relative):
    parts = PurePosixPath(relative).parts
    return (
        isinstance(relative, str)
        and relative.endswith(".json")
        and "\\" not in relative
        and parts
        and not relative.startswith("/")
        and all(p not in ("", ".", "..") and ":" not in p for p in parts)
    )


def load_previous(previous_data):
    """Previously published run records, scanned runs and coverage, per project."""
    runs, scanned, coverage = {}, {}, {}
    if previous_data is None:
        return runs, scanned, coverage
    root = Path(previous_data)
    try:
        index = json.loads((root / "index.json").read_text(encoding="utf-8"))
        entry = index.get("upstream") if isinstance(index, dict) else None
        if not isinstance(entry, dict) or not _safe_relative(entry.get("overview", "")):
            return runs, scanned, coverage
        overview = json.loads((root / entry["overview"]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return runs, scanned, coverage
    for project in overview.get("projects", []):
        pid = project.get("id")
        if isinstance(project.get("coverage"), dict):
            coverage[pid] = project["coverage"]
        for chunk in project.get("files", []):
            relative = chunk.get("path", "")
            if not _safe_relative(relative):
                continue
            try:
                data = json.loads((root / relative).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for row in data.get("runs", []):
                runs.setdefault(pid, {})[
                    (row["job"], row["run_id"], row["job_id"])
                ] = row
            # Older files kept bare run ids; those are read once more and
            # then stored in the per-attempt form.
            scanned.setdefault(pid, set()).update(
                s for s in data.get("scanned_runs", []) if "#" in s and "@" in s
            )
    return runs, scanned, coverage


# ---- collection -----------------------------------------------------------------------


def collect_project(
    project,
    fetch,
    budget,
    now,
    window_days,
    previous,
    scanned,
    workers=6,
    prior_coverage=None,
):
    """Return (records, scanned runs, coverage) for one project."""
    since = (now - timedelta(days=window_days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    repo, branch = project["repository"], project["default_branch"]
    specs = [(job, matcher(job["match"])) for job in project.get("jobs", [])]
    job_ids = {job["id"] for job, _ in specs}
    by_workflow = {}
    for job, match in specs:
        by_workflow.setdefault(job["workflow"], []).append((job, match))
    match_of = {job["id"]: match for job, match in specs}
    spec_of = {job["id"]: job for job, _ in specs}

    # Rows for jobs no longer configured are dropped: conformance rejects a run
    # that names an unknown job, and a removed job must not break publication.
    records = {
        key: row
        for key, row in previous.items()
        if row.get("job") in job_ids
        and (_time(row.get("created_at")) or since) >= since
    }
    done = {key for key in scanned if _scan_day(key) >= since.date().isoformat()}

    # Once a project's window has been read completely, later collections only
    # list runs created since shortly before the last one: older runs are
    # already recorded, and listing a busy repository's whole window costs
    # dozens of large pages. Runs still unfinished last time are re-read by id.
    list_since = since
    prior = prior_coverage or {}
    last = _time(prior.get("collected_at"))
    if prior.get("complete") and last and (_time(prior.get("since")) or now) <= since:
        list_since = max(
            since,
            (last - timedelta(days=2)).replace(
                hour=0, minute=0, second=0, microsecond=0
            ),
        )

    complete = True
    pending = []
    listed_ids = set()
    for workflow, jobs in sorted(by_workflow.items()):
        try:
            runs, truncated = _listed_runs(
                fetch, budget, project, workflow, list_since, now, workers
            )
        except (OutOfBudget, OSError, ValueError) as error:
            print(
                f"  {workflow}: run list not read ({type(error).__name__}: {error})",
                flush=True,
            )
            complete = False
            continue
        if truncated:
            complete = False
        for run in runs:
            listed_ids.add(str(run["id"]))
            if not (_scan_key(run) in done and run.get("status") == "completed"):
                pending.append((run, jobs))
    for row in previous.values():
        if (
            row.get("job") in job_ids
            and row.get("status") != "completed"
            and row["run_id"] not in listed_ids
            and (_time(row.get("created_at")) or since) >= since
        ):
            run = {
                "id": row["run_id"],
                "created_at": row["created_at"],
                "event": row["event"],
                "head_branch": row["ref"],
                "head_sha": row["sha"],
                "run_attempt": row.get("attempt"),
                "status": "unknown",
                "html_url": row["url"],
            }
            pending.append((run, by_workflow[spec_of[row["job"]]["workflow"]]))
            listed_ids.add(row["run_id"])

    # Newest first, in chunks, until the budget is spent.
    pending.sort(key=lambda item: item[0].get("created_at") or "", reverse=True)

    def read_jobs(item):
        run, _ = item
        try:
            jobs, _ = _pages(
                fetch,
                budget,
                f"{API}/repos/{repo}/actions/runs/{run['id']}/jobs",
                "jobs",
                2,
                5,
            )
        except HTTPError as error:
            if error.code == 404:  # the run was deleted
                return {"jobs": [], "gone": True}
            raise
        return {"jobs": jobs}

    read = []
    step = max(1, workers * 4)
    for start in range(0, len(pending), step):
        if budget.exhausted:
            complete = False
            break
        chunk = pending[start : start + step]
        for item, data in zip(chunk, _parallel(chunk, read_jobs, workers)):
            if data is None:
                complete = False
            else:
                read.append((item, data))

    new_rows = []
    for (run, jobs), data in read:
        # A re-run replaces the rows of its earlier attempt.
        for key in [k for k, r in records.items() if r["run_id"] == str(run["id"])]:
            del records[key]
        rows = []
        for job in data["jobs"]:
            for spec, match in jobs:
                if match(job.get("name") or ""):
                    rows.append((_record(run, job, spec), spec))
        new_rows.append((run, rows, data.get("gone", False)))

    # Merge verdicts: which pull request landed each pushed commit, and what its
    # own checks said on the commit that merged. Only jobs that also run on pull
    # requests have one; release and nightly jobs never do.
    def gated(run, spec):
        return (
            run.get("event") == "push"
            and run.get("head_branch") == branch
            and spec["category"] in ("tests", "builds")
        )

    shas = sorted(
        {
            run["head_sha"]
            for run, rows, _ in new_rows
            if any(gated(run, s) for _, s in rows)
        }
    )
    prs = {}
    for sha, found in zip(
        shas,
        _parallel(
            shas, lambda s: {"pr": _merged_pr(fetch, budget, repo, s, branch)}, workers
        ),
    ):
        if found is not None:
            prs[sha] = found["pr"]
    heads = sorted({pr["head_sha"] for pr in prs.values() if pr})
    checks = {}
    for head, result in zip(
        heads,
        _parallel(heads, lambda h: _check_runs(fetch, budget, repo, h, 3), workers),
    ):
        if result is not None:
            checks[head] = result
    gate_ok = len(prs) == len(shas) and len(checks) == len(heads)

    for run, rows, gone in new_rows:
        settled = True
        for row, spec in rows:
            if gated(run, spec):
                if run["head_sha"] not in prs:
                    settled = False
                elif prs[run["head_sha"]] is not None:
                    pr = prs[run["head_sha"]]
                    if pr["head_sha"] not in checks:
                        settled = False
                    else:
                        verdict, check_url = _verdict(
                            checks[pr["head_sha"]], match_of[spec["id"]]
                        )
                        row["pr"] = {
                            "number": pr["number"],
                            "url": pr["url"],
                            "author": pr["author"],
                            "verdict": verdict,
                            "check_url": check_url,
                        }
            records[(row["job"], row["run_id"], row["job_id"])] = row
        finished = (
            gone
            or run.get("status") == "completed"
            or (
                run.get("status") == "unknown"
                and all(r["status"] == "completed" for r, _ in rows)
            )
        )
        # A run is only "done" once its jobs and merge verdicts are settled, so
        # a budget cut or a failed read never freezes a half-read run.
        if finished and settled:
            done.add(_scan_key(run))
    complete = complete and gate_ok
    if complete and list_since == since:
        # Forget scanned runs that are no longer listed (deleted or re-run).
        listed_keys = {key for key in done if key.partition("#")[0] in listed_ids}
        done = listed_keys
    created = [r["created_at"] for r in records.values() if r.get("created_at")]
    coverage = {
        "complete": complete,
        "since": _iso(since),
        "listed_since": _iso(list_since),
        "collected_at": _iso(now),
        "oldest_run_at": min(created) if created else None,
    }
    return list(records.values()), done, coverage


# ---- derived view -----------------------------------------------------------------------


def _days(now, window_days):
    end = now.date()
    return [
        (end - timedelta(days=i)).isoformat() for i in range(window_days - 1, -1, -1)
    ]


def _job_summary(job, rows, days):
    daily = {}
    for row in rows:
        if row["day"] not in days:
            continue
        cell = daily.setdefault(
            row["day"],
            {
                "passed": 0,
                "failed": 0,
                "other": 0,
                "stalled": 0,
                "skipped": 0,
                "running": 0,
                "slow": 0,
            },
        )
        cell[row["state"]] += 1
        if (row.get("queue_seconds") or 0) > SLOW_QUEUE_SECONDS:
            cell["slow"] += 1
    in_window = [r for r in rows if r["day"] in days]
    passed = sum(r["state"] == "passed" for r in in_window)
    failed = sum(r["state"] == "failed" for r in in_window)
    started = [
        r for r in in_window if r["state"] in ("passed", "failed", "other", "running")
    ]
    waits = sorted(
        r["queue_seconds"] for r in started if r.get("queue_seconds") is not None
    )
    ran_days = sorted({r["day"] for r in started})
    last_ran = ran_days[-1] if ran_days else None
    quiet = sorted(
        {
            r["day"]
            for r in in_window
            if r["state"] == "stalled" and (last_ran is None or r["day"] > last_ran)
        }
    )
    steps = {}
    for r in in_window:
        if r["state"] == "failed" and r.get("failed_step"):
            steps[r["failed_step"]] = steps.get(r["failed_step"], 0) + 1
    gate = {}
    for r in rows:
        pr = r.get("pr")
        if not pr:
            continue
        entry = gate.setdefault(
            pr["number"],
            {
                "number": pr["number"],
                "url": pr["url"],
                "author": pr.get("author"),
                "verdict": pr["verdict"],
                "check_url": pr.get("check_url"),
                "main": None,
                "main_url": None,
            },
        )
        # Several rows per pull request (shards, re-runs): a failure on main
        # is what matters, so it wins over a pass.
        if r["state"] == "failed" or (r["state"] == "passed" and entry["main"] is None):
            entry["main"], entry["main_url"] = r["state"], r["url"]
    gate_rows = list(gate.values())
    return {
        **{
            k: job[k]
            for k in (
                "id",
                "label",
                "category",
                "workflow",
                "target",
                "stack",
                "os",
                "where",
                "cadence",
            )
        },
        "daily": daily,
        "decided": passed + failed,
        "passed": passed,
        "started": len(started),
        "skipped": sum(r["state"] == "skipped" for r in in_window),
        "stalled": sum(r["state"] == "stalled" for r in in_window),
        "last_ran": last_ran,
        "quiet_days": quiet,
        "median_queue_seconds": int(median(waits)) if waits else None,
        "failed_steps": dict(sorted(steps.items(), key=lambda kv: -kv[1])[:8]),
        "gate": (
            None
            if not gate_rows
            else {
                "merged": len(gate_rows),
                "passed": sum(g["verdict"] == "passed" for g in gate_rows),
                "failed": sum(g["verdict"] == "failed" for g in gate_rows),
                "not_triggered": sum(
                    g["verdict"] == "not_triggered" for g in gate_rows
                ),
                "no_result": sum(g["verdict"] == "no_result" for g in gate_rows),
                "red": sorted(
                    (g for g in gate_rows if g["verdict"] == "failed"),
                    key=lambda g: -g["number"],
                ),
                "escaped": sorted(
                    (
                        g
                        for g in gate_rows
                        if g["verdict"] in ("not_triggered", "no_result")
                        and g["main"] == "failed"
                    ),
                    key=lambda g: -g["number"],
                ),
            }
        ),
    }


def _not_running(job):
    return job["category"] == "tests" and (
        job["started"] == 0 or bool(job["quiet_days"])
    )


def _badge(jobs, targets):
    tested = [j for j in jobs if j["category"] == "tests" and j["started"]]
    hits = [j for j in tested if j["target"] in targets]
    if hits:
        reason = "tested on main on " + ", ".join(
            f"{j['target']} ({j['label']}{', quiet since ' + j['last_ran'] if j['quiet_days'] else ''})"
            for j in hits
        )
        return {"state": "up", "reason": reason}
    if tested:
        return {
            "state": "partial",
            "reason": "client hardware is tested on main ("
            + ", ".join(f"{j['label']} on {j['target']}" for j in tested)
            + ") but no test runs on "
            + " or ".join(targets),
        }
    return {"state": "down", "reason": "no test on main runs on client hardware"}


def _platforms(jobs, ships):
    out = {}
    for os_name in OSES:
        mine = [j for j in jobs if j["os"] == os_name]
        built = [j for j in mine if j["category"] != "tests" and j["started"]]
        tested = [j for j in mine if j["category"] == "tests" and j["started"]]

        def rate(rows):
            dec = sum(j["decided"] for j in rows)
            return round(100 * sum(j["passed"] for j in rows) / dec) if dec else None

        out[os_name] = {
            "built": bool(built or tested),
            "built_rate": rate(built),
            "tested": bool(tested),
            "tested_rate": rate(tested),
            "shipped": ships.get(os_name),
        }
    return out


def _findings(jobs, merged_red):
    out = []
    for j in jobs:
        if j["category"] == "tests" and j["quiet_days"] and j["last_ran"]:
            out.append(
                {
                    "kind": "not_running",
                    "job": j["id"],
                    "head": f"{j['label']} has not run on a machine since {j['last_ran']}.",
                    "body": f"Work was requested on {len(j['quiet_days'])} days since, and no machine took it. "
                    "A cancelled job is not a failed one, so nothing in GitHub turns red.",
                }
            )
        elif j["category"] == "tests" and not j["started"] and j["skipped"]:
            out.append(
                {
                    "kind": "never_ran",
                    "job": j["id"],
                    "head": f"{j['label']} has not run once in the window.",
                    "body": f"It was skipped {j['skipped']} times by its own condition.",
                }
            )
        steps = j["failed_steps"]
        total = sum(steps.values())
        if (
            j["category"] == "tests"
            and total >= 10
            and steps.get("Set up job", 0) >= 0.3 * total
        ):
            out.append(
                {
                    "kind": "runner_health",
                    "job": j["id"],
                    "head": f"{steps['Set up job']} of the {total} failures in {j['label']} happened before any test ran.",
                    "body": "They failed in `Set up job`, so the machine was unhealthy; nothing was tested.",
                }
            )
        gate = j["gate"]
        if gate and gate["merged"] and gate["not_triggered"] >= 0.5 * gate["merged"]:
            out.append(
                {
                    "kind": "not_on_pr",
                    "job": j["id"],
                    "head": f"{j['label']} never ran on {gate['not_triggered']} of {gate['merged']} merged pull requests.",
                    "body": f"Those changes met AMD hardware here only after merge; {len(gate['escaped'])} of them then failed on main.",
                }
            )
    if merged_red:
        out.insert(
            0,
            {
                "kind": "merged_red",
                "job": None,
                "head": f"{merged_red} pull requests were merged with an AMD job failing on the merged commit.",
                "body": "Each was red on the exact commit that landed.",
            },
        )
    return out


def derive_project(project, rows, days, targets, coverage, files):
    by_job = {}
    for row in rows:
        by_job.setdefault(row["job"], []).append(row)
    jobs = [
        _job_summary(job, by_job.get(job["id"], []), set(days))
        for job in project.get("jobs", [])
    ]
    decided = sum(j["decided"] for j in jobs)
    passed = sum(j["passed"] for j in jobs)
    red = {g["number"] for j in jobs if j["gate"] for g in j["gate"]["red"]}
    badge = _badge(jobs, targets)
    if badge["state"] == "down" and project.get("note"):
        badge["reason"] = project["note"]
    return {
        "id": project["id"],
        "label": project["label"],
        "repository": project["repository"],
        "default_branch": project["default_branch"],
        "note": project.get("note"),
        "forks": project.get("forks", []),
        "badge": badge,
        "kpis": {
            "decided": decided,
            "passed": passed,
            "pass_rate": round(100 * passed / decided, 1) if decided else None,
            "not_running": sum(_not_running(j) for j in jobs),
            "merged_red": len(red),
        },
        "jobs": jobs,
        "platforms": _platforms(jobs, project.get("ships", {})),
        "findings": _findings(jobs, len(red)),
        "coverage": coverage,
        "files": files,
    }


def write_upstream(destination, config, collected, now, write_json):
    """Write monthly run files and the overview; return the index entry."""
    window = config["window_days"]
    days = _days(now, window)
    targets = config["client_rule"]["targets"]
    projects = []
    for project in config["projects"]:
        rows, scanned, coverage = collected.get(
            project["id"], ([], set(), {"complete": True})
        )
        rows = [r for r in rows if r["day"] >= days[0]]
        months = {}
        for row in rows:
            months.setdefault(row["day"][:7], []).append(row)
        # The newest month file carries every scanned run id, including runs
        # where no configured job matched, so the next collection does not pay
        # for them again.
        newest = days[-1][:7]
        months.setdefault(newest, [])
        files = []
        for month in sorted(months, reverse=True):
            chunk = sorted(
                months[month], key=lambda r: (r["created_at"], r["job"], r["job_id"])
            )
            if not chunk and month != newest:
                continue
            relative = f"upstream/{project['id']}/ci/{month}.json"
            write_json(
                Path(destination) / relative,
                {
                    "schema_version": SCHEMA_VERSION,
                    "project": project["id"],
                    "month": month,
                    "runs": chunk,
                    "scanned_runs": sorted(scanned) if month == newest else [],
                },
            )
            files.append({"month": month, "path": relative, "run_count": len(chunk)})
        projects.append(derive_project(project, rows, days, targets, coverage, files))
    overview = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _iso(now),
        "window": {"start": days[0], "end": days[-1], "days": window},
        "client_rule": config["client_rule"],
        "projects": projects,
    }
    write_json(Path(destination) / "upstream/overview.json", overview)
    complete = all(p["coverage"].get("complete", True) for p in projects)
    return {
        "schema_version": SCHEMA_VERSION,
        "overview": "upstream/overview.json",
        "project_count": len(projects),
        "status": "fresh" if complete else "partial",
    }


def collect_upstream(
    config,
    destination,
    fetch,
    now,
    write_json,
    previous_data=None,
    budget_calls=800,
    workers=6,
):
    """Collect and write the upstream view. Never raises for API trouble: a
    project that cannot be read keeps its previous records and is marked
    incomplete, because readiness publication must not depend on it."""
    validate_projects(config)
    now = now if isinstance(now, datetime) else _time(now)
    calls = [0]
    lock = Lock()

    def counted(url):
        with lock:
            calls[0] += 1
        return fetch(url)

    previous, scanned, prior_coverage = load_previous(previous_data)
    used = 0
    collected = {}
    errors = []
    for pos, project in enumerate(config["projects"]):
        pid = project["id"]
        # Split what is left evenly over the projects still to go, so one busy
        # repository cannot spend the whole budget on its backfill.
        left = len(config["projects"]) - pos
        budget = Budget(max(0, budget_calls - used) // left)
        try:
            collected[pid] = collect_project(
                project,
                counted,
                budget,
                now,
                config["window_days"],
                previous.get(pid, {}),
                scanned.get(pid, set()),
                workers=workers,
                prior_coverage=prior_coverage.get(pid),
            )
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(
                PipelineValidationError(
                    "upstream", pid, "collect", f"{type(error).__name__}: {error}"
                ).diagnostic
            )
            configured = {job["id"] for job in project.get("jobs", [])}
            collected[pid] = (
                [
                    r
                    for r in previous.get(pid, {}).values()
                    if r.get("job") in configured
                ],
                scanned.get(pid, set()),
                {"complete": False, "error": str(error)},
            )
        used += budget.used
        rows, _, coverage = collected[pid]
        print(
            f"upstream {pid}: {len(rows)} job records, "
            f"{'complete' if coverage.get('complete') else 'partial'}, "
            f"{calls[0]} API calls so far",
            flush=True,
        )
    entry = write_upstream(destination, config, collected, now, write_json)
    entry["api_calls"] = calls[0]
    if errors:
        entry["errors"] = errors
        entry["status"] = "partial"
    return entry


# ---- conformance ---------------------------------------------------------------------

FILE_PATH = re.compile(r"upstream/([a-z0-9][a-z0-9-]*)/ci/(\d{4}-\d{2})\.json")
VERDICTS = ("passed", "failed", "not_triggered", "no_result")
BADGES = ("up", "partial", "down")


def _fail(path, field, reason):
    raise PipelineValidationError("pipeline", path, field, reason)


def _ok(condition, path, field, reason):
    if not condition:
        _fail(path, field, reason)


def _count(value):
    return type(value) is int and value >= 0


def _read(root, relative):
    _ok(
        _safe_relative(relative),
        relative,
        "/",
        "upstream paths must stay inside the dataset",
    )
    target = root
    for part in PurePosixPath(relative).parts:
        target = target / part
        _ok(
            not target.is_symlink(),
            relative,
            "/",
            "upstream paths cannot contain symlinks",
        )
    try:
        value = json.loads(
            target.read_text(encoding="utf-8"),
            parse_constant=lambda v: (_ for _ in ()).throw(ValueError(v)),
        )
    except (OSError, ValueError, UnicodeError) as error:
        _fail(relative, "/", f"cannot read upstream JSON: {error}")
    _ok(isinstance(value, dict), relative, "/", "expected a JSON object")
    return value


def validate_upstream_dataset(root, entry):
    """Validate the upstream view referenced by ``index.json`` and return its paths."""
    root = Path(root).resolve()
    _ok(isinstance(entry, dict), "index.json", "/upstream", "expected object")
    _ok(
        entry.get("schema_version") == SCHEMA_VERSION,
        "index.json",
        "/upstream/schema_version",
        "expected upstream schema version 1",
    )
    _ok(
        entry.get("overview") == "upstream/overview.json",
        "index.json",
        "/upstream/overview",
        "upstream overview lives at upstream/overview.json",
    )
    _ok(
        entry.get("status") in ("fresh", "partial"),
        "index.json",
        "/upstream/status",
        "expected fresh or partial",
    )
    _ok(
        _count(entry.get("project_count")),
        "index.json",
        "/upstream/project_count",
        "expected nonnegative project count",
    )
    paths = {entry["overview"]}
    overview = _read(root, entry["overview"])
    where = entry["overview"]
    _ok(
        overview.get("schema_version") == SCHEMA_VERSION,
        where,
        "/schema_version",
        "expected 1",
    )
    _ok(
        _time(overview.get("generated_at")) is not None,
        where,
        "/generated_at",
        "expected timestamp",
    )
    window = overview.get("window") or {}
    _ok(
        isinstance(window.get("start"), str)
        and isinstance(window.get("end"), str)
        and type(window.get("days")) is int
        and window["start"] <= window["end"],
        where,
        "/window",
        "expected start, end and days",
    )
    projects = overview.get("projects")
    _ok(
        isinstance(projects, list) and len(projects) == entry["project_count"],
        where,
        "/projects",
        "project list must match the catalog count",
    )
    seen = set()
    for pos, project in enumerate(projects):
        at = f"/projects/{pos}"
        pid = project.get("id")
        _ok(
            isinstance(pid, str) and PROJECT_ID.fullmatch(pid) and pid not in seen,
            where,
            at + "/id",
            "project ids must be unique slugs",
        )
        seen.add(pid)
        _ok(
            (project.get("badge") or {}).get("state") in BADGES,
            where,
            at + "/badge",
            "invalid badge",
        )
        jobs = project.get("jobs")
        _ok(isinstance(jobs, list), where, at + "/jobs", "expected jobs")
        job_ids = set()
        for jpos, job in enumerate(jobs):
            jat = f"{at}/jobs/{jpos}"
            _ok(
                job.get("category") in CATEGORIES
                and job.get("stack") in STACKS
                and job.get("os") in OSES,
                where,
                jat,
                "invalid job classification",
            )
            job_ids.add(job.get("id"))
            daily = job.get("daily")
            _ok(
                isinstance(daily, dict),
                where,
                jat + "/daily",
                "expected daily aggregates",
            )
            passed = failed = 0
            for day, cell in daily.items():
                _ok(
                    window["start"] <= day <= window["end"],
                    where,
                    f"{jat}/daily/{day}",
                    "day outside window",
                )
                _ok(
                    all(_count(cell.get(k)) for k in STATES + ("slow",)),
                    where,
                    f"{jat}/daily/{day}",
                    "expected nonnegative state counts",
                )
                passed += cell["passed"]
                failed += cell["failed"]
            _ok(
                job.get("passed") == passed and job.get("decided") == passed + failed,
                where,
                jat,
                "job totals must equal its daily aggregates",
            )
        kpis = project.get("kpis") or {}
        _ok(
            kpis.get("decided") == sum(j["decided"] for j in jobs)
            and kpis.get("passed") == sum(j["passed"] for j in jobs),
            where,
            at + "/kpis",
            "project totals must equal its jobs",
        )
        for fpos, chunk in enumerate(project.get("files") or []):
            relative = chunk.get("path")
            match = FILE_PATH.fullmatch(relative or "")
            _ok(
                match is not None
                and match.group(1) == pid
                and match.group(2) == chunk.get("month"),
                where,
                f"{at}/files/{fpos}",
                "file path must be upstream/<project>/ci/<month>.json",
            )
            data = _read(root, relative)
            paths.add(relative)
            _ok(
                data.get("schema_version") == SCHEMA_VERSION
                and data.get("project") == pid
                and data.get("month") == chunk["month"],
                relative,
                "/",
                "file identity does not match",
            )
            runs = data.get("runs")
            _ok(
                isinstance(runs, list) and len(runs) == chunk.get("run_count"),
                relative,
                "/runs",
                "run count does not match the overview",
            )
            keys = set()
            for rpos, run in enumerate(runs):
                rat = f"/runs/{rpos}"
                key = (run.get("job"), run.get("run_id"), run.get("job_id"))
                _ok(key not in keys, relative, rat, "duplicate run record")
                keys.add(key)
                _ok(
                    run.get("job") in job_ids,
                    relative,
                    rat + "/job",
                    "run names an unknown job",
                )
                _ok(
                    run.get("state") in STATES,
                    relative,
                    rat + "/state",
                    "invalid state",
                )
                _ok(
                    isinstance(run.get("day"), str)
                    and run["day"][:7] == chunk["month"],
                    relative,
                    rat + "/day",
                    "run is filed under the wrong month",
                )
                _ok(
                    isinstance(run.get("url"), str)
                    and run["url"].startswith("https://github.com/"),
                    relative,
                    rat + "/url",
                    "expected a GitHub link",
                )
                if run.get("pr") is not None:
                    _ok(
                        run["pr"].get("verdict") in VERDICTS,
                        relative,
                        rat + "/pr/verdict",
                        "invalid verdict",
                    )
    return paths


# ---- command line ------------------------------------------------------------------------


def main(argv=None):
    """Collect only the upstream view into an existing dataset directory.

    The full pipeline (scripts/check.py, scripts/collect.py) collects the upstream
    view after the readiness dataset. This entry point refreshes just the upstream
    part, which is what you want while working on it locally:

        python scripts/upstream.py --output-dir data/local-preview --seed-from data

    ``--seed-from`` copies the readiness files of a published dataset when the
    output directory has no index yet. The previous upstream records in the
    output directory are reused, so repeated runs fill a large window gradually
    within the API budget.
    """
    import argparse
    import os
    import shutil
    import sys

    if __package__:
        from .collect import fetch_json, write_json
    else:
        from collect import fetch_json, write_json

    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description=main.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--projects", type=Path, default=root / "projects.json")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--seed-from", type=Path, help="published dataset to copy readiness files from"
    )
    parser.add_argument(
        "--budget", type=int, default=int(os.environ.get("UPSTREAM_API_BUDGET", "800"))
    )
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args(argv)
    out = args.output_dir
    if not (out / "index.json").exists():
        if not args.seed_from:
            print(
                f"{out}/index.json is missing; pass --seed-from <published data dir>",
                file=sys.stderr,
            )
            return 1
        out.mkdir(parents=True, exist_ok=True)
        for name in ("index.json", "latest.json", "sync.json"):
            if (args.seed_from / name).exists():
                shutil.copy2(args.seed_from / name, out / name)
        for name in ("rocm", "performance", "upstream"):
            if (args.seed_from / name).is_dir():
                shutil.copytree(args.seed_from / name, out / name, dirs_exist_ok=True)
    index = json.loads((out / "index.json").read_text(encoding="utf-8"))
    config = json.loads(args.projects.read_text(encoding="utf-8"))
    entry = collect_upstream(
        config,
        out,
        fetch=fetch_json,
        now=datetime.now(timezone.utc),
        write_json=write_json,
        previous_data=out,
        budget_calls=args.budget,
        workers=args.workers,
    )
    index["upstream"] = entry
    write_json(out / "index.json", index)
    validate_upstream_dataset(out, entry)
    print(
        f"upstream: {entry['project_count']} projects, {entry['status']}, {entry['api_calls']} API calls"
    )
    for error in entry.get("errors", []):
        print(f"  error: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

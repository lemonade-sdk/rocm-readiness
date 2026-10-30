"""Restore and publish the final dashboard dataset on the main branch."""

import argparse
from datetime import datetime, timezone
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

if __package__:
    from .execution_dataset import validate_execution_file
    from .dataset import (
        _load_previous,
        _read_previous,
        _validate_comparison,
        _systems_for,
    )
    from .sync import load_last_success
else:
    from execution_dataset import validate_execution_file
    from dataset import (
        _load_previous,
        _read_previous,
        _validate_comparison,
        _systems_for,
    )
    from sync import load_last_success


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise ValueError(f"git {args[0]} failed: {result.stderr.strip()}")
    return result


def resolve_remote(remote):
    if remote == "origin":
        remote = git(None, "remote", "get-url", "origin").stdout.strip()
    if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", remote) and not re.match(
        r"^[^/]+@[^:]+:", remote
    ):
        remote = str(Path(remote).resolve())
    return remote


def remote_head(remote, branch):
    if branch != "main":
        raise ValueError("publication target must be main")
    git(None, "check-ref-format", f"refs/heads/{branch}")
    result = git(
        None,
        "ls-remote",
        "--exit-code",
        "--heads",
        remote,
        f"refs/heads/{branch}",
        check=False,
    )
    if result.returncode == 2 and not result.stdout:
        return None
    if result.returncode:
        raise ValueError(f"cannot read remote branch: {result.stderr.strip()}")
    lines = result.stdout.splitlines()
    if len(lines) != 1 or not re.fullmatch(
        r"[0-9a-f]{40}\s+refs/heads/" + re.escape(branch), lines[0]
    ):
        raise ValueError("unexpected remote branch response")
    return lines[0].split()[0]


def scratch(work_dir, remote, head):
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    tmp = tempfile.TemporaryDirectory(dir=work_dir, prefix="publication-")
    root = Path(tmp.name)
    git(root, "init", "-q")
    git(root, "config", "user.name", "github-actions[bot]")
    git(
        root,
        "config",
        "user.email",
        "41898282+github-actions[bot]@users.noreply.github.com",
    )
    if head:
        git(root, "fetch", "-q", remote, head)
        git(root, "checkout", "-q", "--detach", head)
    return tmp, root


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"unsafe or missing JSON file: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def checked(root, relative):
    if not isinstance(relative, str) or "\\" in relative:
        raise ValueError("invalid manifest path")
    parts = PurePosixPath(relative).parts
    if (
        not parts
        or relative.startswith("/")
        or any(p in (".", "..") or ":" in p for p in parts)
        or not relative.endswith(".json")
    ):
        raise ValueError(f"invalid manifest path: {relative}")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"symlink in manifest path: {relative}")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"manifest path escapes dataset: {relative}")
    read_json(path)
    return path


def manifest(root, allow_legacy=False):
    root = Path(root)
    checked(root, "index.json")
    index = read_json(root / "index.json")
    if not allow_legacy and (
        type(index.get("attribution_version")) is not int
        or index["attribution_version"] != 2
    ):
        raise ValueError("current attribution version is required for publication")
    paths = {"index.json"}
    for item in index["versions"]:
        overview_path = item["overview"]
        paths.add(overview_path)
        checked(root, overview_path)
        overview = _read_previous(root.resolve(), overview_path)
        paths.update(entry["path"] for entry in overview["history"])
        if overview.get("performance", {}).get("path"):
            paths.add(overview["performance"]["path"])
        if overview.get("execution", {}).get("path"):
            execution = overview["execution"]
            expected = f"rocm/{item['rocm_version']}/executions.json"
            if execution["path"] != expected:
                raise ValueError("invalid execution path")
            detail = read_json(checked(root, expected))
            attempts = validate_execution_file(detail, item["rocm_version"])
            if execution.get("summaries") != detail["summaries"] or execution.get(
                "attempt_count"
            ) != len(attempts):
                raise ValueError("execution summary mismatch")
            paths.add(expected)
    entries = [
        ("comparison_performance", "performance/comparisons.json"),
        ("unassigned_performance", "performance/unassigned.json"),
    ]
    present = [(key, path) for key, path in entries if key in index]
    if len(present) > 1:
        raise ValueError("invalid performance partition manifest")
    if not present:
        for path in paths:
            checked(root, path)
        _load_previous(root)
        return paths
    key, expected_path = present[0]
    if key == "unassigned_performance" and not allow_legacy:
        raise ValueError(
            "legacy performance partition is only supported for restoration"
        )
    partition = index[key]
    if (
        not isinstance(partition, dict)
        or partition.get("path") != expected_path
        or type(partition.get("count")) is not int
        or partition["count"] < 0
    ):
        raise ValueError("invalid performance partition manifest")
    data = read_json(checked(root, partition["path"]))
    if (
        not isinstance(data, dict)
        or data.get("schema_version") != 2
        or not isinstance(data.get("measurements"), list)
        or not isinstance(data.get("systems"), list)
        or len(data["measurements"]) != partition["count"]
    ):
        raise ValueError("invalid performance partition data")
    if key == "comparison_performance":
        for row in data["measurements"]:
            _validate_comparison(row)
        systems = {}
        for system in data["systems"]:
            if (
                not isinstance(system, dict)
                or not isinstance(system.get("id"), str)
                or not isinstance(system.get("source_id"), str)
            ):
                raise ValueError("invalid comparison system")
            system_key = (system["source_id"], system["id"])
            if system_key in systems:
                raise ValueError("duplicate comparison system")
            systems[system_key] = system
        _systems_for(data["measurements"], systems)
    paths.add(partition["path"])
    for path in paths:
        checked(root, path)
    _load_previous(root)
    return paths


def valid_sync(dataset):
    checked(dataset, "sync.json")
    data = read_json(dataset / "sync.json")
    with tempfile.TemporaryDirectory() as temp:
        write(Path(temp) / "sync.json", data)
        load_last_success(temp)
    return data["sync"]


def pointer(root):
    if (root / "data").is_symlink():
        raise ValueError("unsafe data directory")
    latest = read_json(root / "data/latest.json")
    commit = latest.get("data_commit")
    if (
        latest.get("schema_version") != 1
        or (commit is not None and not re.fullmatch(r"[0-9a-f]{40}", commit))
        or (commit is None and latest.get("index_url") is not None)
    ):
        raise ValueError("invalid latest pointer")
    if commit and (
        not isinstance(latest.get("index_url"), str)
        or not re.fullmatch(
            r"https://raw\.githubusercontent\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/"
            + commit
            + r"/data/index\.json",
            latest["index_url"],
        )
    ):
        raise ValueError("invalid latest index URL")
    return latest


def restore(remote, branch, work_dir, output_dir, state_file, source_commit=None):
    resolved = resolve_remote(remote)
    Path(state_file).unlink(missing_ok=True)
    head = remote_head(resolved, branch)
    if head is None:
        raise ValueError("main branch does not exist")
    tmp, root = scratch(work_dir, resolved, head)
    try:
        if source_commit is not None:
            if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
                raise ValueError("invalid source commit")
            if git(
                root, "cat-file", "-e", f"{source_commit}^{{commit}}", check=False
            ).returncode:
                raise ValueError("source commit is unavailable")
            diff = git(
                root,
                "diff",
                "--quiet",
                source_commit,
                head,
                "--",
                ".",
                ":(exclude,top)data",
                check=False,
            )
            if diff.returncode == 1:
                raise ValueError("source tree changed since the workflow started")
            if diff.returncode:
                raise ValueError(f"cannot compare source commit: {diff.stderr.strip()}")
        out = Path(output_dir)
        staging = Path(tempfile.mkdtemp(dir=Path(work_dir), prefix="restore-"))
        try:
            if (root / "data").is_symlink():
                raise ValueError("unsafe data directory")
            if (root / "data/latest.json").exists() or (
                root / "data/latest.json"
            ).is_symlink():
                latest = pointer(root)
                commit = latest["data_commit"]
                if commit:
                    git(root, "cat-file", "-e", f"{commit}^{{commit}}")
                    git(root, "merge-base", "--is-ancestor", commit, head)
                    tree = git(
                        root, "ls-tree", "-r", "-z", commit, "--", "data/"
                    ).stdout
                    for entry in tree.split("\0"):
                        if not entry:
                            continue
                        meta, name = entry.split("\t", 1)
                        if not name.startswith("data/"):
                            raise ValueError("unexpected published path")
                        name = name[len("data/") :]
                        mode, kind, obj = meta.split()
                        if (
                            mode != "100644"
                            or kind != "blob"
                            or not name.endswith(".json")
                        ):
                            raise ValueError(f"unsafe published file: {name}")
                        parts = PurePosixPath(name).parts
                        if (
                            not parts
                            or name.startswith("/")
                            or any(p in (".", "..") or ":" in p for p in parts)
                        ):
                            raise ValueError(f"unsafe published path: {name}")
                        target = staging.joinpath(*parts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(
                            git(root, "cat-file", "blob", obj).stdout, encoding="utf-8"
                        )
                    allowed = manifest(staging, allow_legacy=True)
                    if read_json(staging / "index.json").get("sync") != valid_sync(
                        staging
                    ):
                        raise ValueError(
                            "published index sync does not match sync metadata"
                        )
                    existing = {
                        p.relative_to(staging).as_posix()
                        for p in staging.rglob("*")
                        if p.is_file()
                    }
                    if existing - allowed - {"sync.json"}:
                        raise ValueError("unexpected published dataset files")
                write(staging / "latest.json", latest)
                write(
                    staging / "sync.json", {"schema_version": 1, "sync": latest["sync"]}
                )
                valid_sync(staging)
            if out.exists():
                shutil.rmtree(out)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(staging), str(out))
            write(
                Path(state_file),
                {"schema_version": 1, "remote": remote, "branch": branch, "head": head},
            )
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    finally:
        tmp.cleanup()


def publish(
    remote,
    branch,
    repository,
    work_dir,
    dataset,
    state_file,
    collection_result="success",
):
    if collection_result not in ("success", "failure", "cancelled", "skipped"):
        raise ValueError("invalid collection result")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("invalid repository")
    state = read_json(Path(state_file))
    if (
        state.get("schema_version") != 1
        or state.get("remote") != remote
        or state.get("branch") != branch
        or (
            state.get("head") is not None
            and not re.fullmatch(r"[0-9a-f]{40}", state["head"])
        )
    ):
        raise ValueError("invalid publication state")
    expected = state["head"]
    if expected is None:
        raise ValueError("main branch does not exist")
    resolved = resolve_remote(remote)
    if remote_head(resolved, branch) != expected:
        raise ValueError("remote branch changed since restore")
    tmp, root = scratch(work_dir, resolved, expected)
    try:
        if (root / "data").is_symlink():
            raise ValueError("unsafe data directory")
        has_pointer = (root / "data/latest.json").exists() or (
            root / "data/latest.json"
        ).is_symlink()
        prior = (
            pointer(root) if has_pointer else {"data_commit": None, "index_url": None}
        )
        dataset = Path(dataset)
        prior_sync = prior.get("sync")
        if has_pointer and prior_sync is None:
            raise ValueError("published pointer is missing sync metadata")
        if prior_sync is not None:
            with tempfile.TemporaryDirectory() as temp:
                write(
                    Path(temp) / "sync.json", {"schema_version": 1, "sync": prior_sync}
                )
                valid_sync(Path(temp))
        last_success = prior_sync["last_successful_at"] if prior_sync else None

        def failure(error):
            now = datetime.now(timezone.utc)
            if prior_sync and now < datetime.fromisoformat(
                prior_sync["attempted_at"].replace("Z", "+00:00")
            ):
                raise ValueError(
                    "cannot publish status before the prior attempt timestamp"
                )
            return {
                "attempted_at": now.isoformat(),
                "status": "failed",
                "last_successful_at": last_success,
                "errors": [
                    {
                        "source_id": "pipeline",
                        "record": "",
                        "field": "publication",
                        "reason": str(error),
                    }
                ],
            }

        try:
            sync = valid_sync(dataset)
            if collection_result != "success" and (
                sync["status"] != "failed"
                or (
                    prior_sync
                    and datetime.fromisoformat(
                        sync["attempted_at"].replace("Z", "+00:00")
                    )
                    <= datetime.fromisoformat(
                        prior_sync["attempted_at"].replace("Z", "+00:00")
                    )
                )
            ):
                raise ValueError("fresh failure metadata unavailable")
            if prior_sync and datetime.fromisoformat(
                sync["attempted_at"].replace("Z", "+00:00")
            ) < datetime.fromisoformat(
                prior_sync["attempted_at"].replace("Z", "+00:00")
            ):
                raise ValueError("stale sync attempt predates the published status")
            if sync["status"] == "failed":
                sync = {**sync, "last_successful_at": last_success}
        except (ValueError, KeyError, TypeError, OSError) as error:
            if collection_result != "success":
                error = f"collection job {collection_result}; fresh failure metadata unavailable: {error}"
            sync = failure(error)
        success = sync["status"] == "success"
        if success:
            try:
                paths = manifest(dataset)
                if read_json(dataset / "index.json").get("sync") != sync:
                    raise ValueError("index sync does not match sync metadata")
            except (ValueError, KeyError, TypeError, OSError) as error:
                success = False
                sync = failure(error)
        if success:
            git(root, "switch", "-c", "dashboard-data")
            data_root = root / "data"
            if data_root.exists():
                if not data_root.is_dir():
                    raise ValueError("unsafe data directory")
                shutil.rmtree(data_root)
            for relative in paths:
                target = data_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative == "index.json":
                    index = read_json(dataset / relative)
                    for source in index.get("sources", []):
                        source.pop("snapshot", None)
                    write(target, index)
                else:
                    shutil.copyfile(checked(dataset, relative), target)
            write(data_root / "sync.json", {"schema_version": 1, "sync": sync})
            git(root, "add", "-f", "-A", "--", "data")
            git(root, "commit", "--allow-empty", "-qm", "Stage dashboard data")
            git(root, "checkout", "-q", "--detach", expected)
            git(root, "merge", "--squash", "dashboard-data")
            git(root, "commit", "--allow-empty", "-qm", "Publish dashboard data")
            commit = git(root, "rev-parse", "HEAD").stdout.strip()
            prior = {
                "data_commit": commit,
                "index_url": f"https://raw.githubusercontent.com/{repository}/{commit}/data/index.json",
            }
        latest = {
            "schema_version": 1,
            "data_commit": prior["data_commit"],
            "index_url": prior["index_url"],
            "sync": sync,
        }
        if (root / "data/sync.json").is_symlink():
            raise ValueError("unsafe sync status file")
        write(root / "data/latest.json", latest)
        write(root / "data/sync.json", {"schema_version": 1, "sync": sync})
        git(root, "add", "-f", "--", "data/latest.json", "data/sync.json")
        git(
            root,
            "commit",
            "--allow-empty",
            "-qm",
            "Update dashboard publication status",
        )
        if remote_head(resolved, branch) != expected:
            raise ValueError("remote branch changed since restore")
        if expected:
            git(root, "merge-base", "--is-ancestor", expected, "HEAD")
        ref = f"refs/heads/{branch}"
        git(
            root,
            "push",
            "--atomic",
            f"--force-with-lease={ref}:{expected or ''}",
            resolved,
            f"HEAD:{ref}",
        )
        return success
    finally:
        tmp.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("restore", "publish"):
        p = sub.add_parser(name)
        p.add_argument("--remote", required=True)
        p.add_argument("--branch", default="main")
        p.add_argument("--work-dir", type=Path, required=True)
        p.add_argument("--state-file", type=Path, required=True)
        if name == "restore":
            p.add_argument("--output-dir", type=Path, required=True)
            p.add_argument("--source-commit")
        else:
            p.add_argument("--repository", required=True)
            p.add_argument("--dataset", type=Path, required=True)
            p.add_argument(
                "--collection-result",
                choices=("success", "failure", "cancelled", "skipped"),
                default="success",
            )
    args = parser.parse_args()
    try:
        if args.command == "restore":
            restore(
                args.remote,
                args.branch,
                args.work_dir,
                args.output_dir,
                args.state_file,
                source_commit=args.source_commit,
            )
            return 0
        return (
            0
            if publish(
                args.remote,
                args.branch,
                args.repository,
                args.work_dir,
                args.dataset,
                args.state_file,
                collection_result=args.collection_result,
            )
            else 1
        )
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Publication {args.command} failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

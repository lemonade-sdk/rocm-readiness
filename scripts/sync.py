"""Read and publish collection synchronization status."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile

if __package__:
    from .validation import PipelineValidationError
else:
    from validation import PipelineValidationError


def _valid_time(value):
    if not isinstance(value, str):
        return False
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.utcoffset() == timezone.utc.utcoffset(result)
    except ValueError:
        return False


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as error:
        raise PipelineValidationError(
            "pipeline", str(path), "sync", "invalid sync metadata"
        ) from error


def _valid_attempt(value):
    return (
        isinstance(value, dict)
        and set(value) == {"attempted_at", "status", "errors"}
        and _valid_time(value["attempted_at"])
        and value["status"] in ("success", "failed")
        and isinstance(value["errors"], list)
        and all(
            isinstance(error, dict)
            and set(error) == {"source_id", "record", "field", "reason"}
            and all(isinstance(item, str) for item in error.values())
            for error in value["errors"]
        )
        and (value["status"] != "success" or not value["errors"])
    )


def validate_sync(sync, path):
    good = (
        isinstance(sync, dict)
        and set(sync) in (
            {"attempted_at", "status", "last_successful_at", "errors"},
            {"attempted_at", "status", "last_successful_at", "errors", "attempts"},
        )
        and _valid_attempt({key: sync[key] for key in ("attempted_at", "status", "errors")})
        and (
            sync["last_successful_at"] is None
            or _valid_time(sync["last_successful_at"])
        )
        and (
            sync["status"] != "success"
            or sync["last_successful_at"] == sync["attempted_at"]
        )
    )
    if good and "attempts" in sync:
        good = isinstance(sync["attempts"], list) and all(
            _valid_attempt(attempt)
            and datetime.fromisoformat(attempt["attempted_at"].replace("Z", "+00:00"))
            <= datetime.fromisoformat(sync["attempted_at"].replace("Z", "+00:00"))
            for attempt in sync["attempts"]
        )
    if not good:
        raise PipelineValidationError(
            "pipeline", str(path), "sync", "invalid sync metadata"
        )
    return sync


def retain_attempts(sync, *previous):
    """Keep observed attempts in the calendar's 14 UTC dates, not daily verdicts."""
    now = datetime.fromisoformat(sync["attempted_at"].replace("Z", "+00:00"))
    start = now.date() - timedelta(days=13)
    attempts = {}
    for record in (*previous, sync):
        if record is None:
            continue
        current = {key: record[key] for key in ("attempted_at", "status", "errors")}
        for attempt in [*record.get("attempts", []), current]:
            when = datetime.fromisoformat(attempt["attempted_at"].replace("Z", "+00:00"))
            if start <= when.date() <= now.date() and when <= now:
                key = json.dumps(attempt, sort_keys=True)
                attempts[key] = attempt
    return {
        **sync,
        "attempts": sorted(
            attempts.values(),
            key=lambda attempt: datetime.fromisoformat(
                attempt["attempted_at"].replace("Z", "+00:00")
            ),
        ),
    }


def load_last_success(destination, previous_data=None):
    roots = [Path(destination)]
    if previous_data is not None and Path(previous_data) != roots[0]:
        roots.append(Path(previous_data))
    for root in roots:
        path = root / "sync.json"
        if not path.exists():
            continue
        data = _read(path)
        sync = validate_sync(
            data.get("sync")
            if isinstance(data, dict) and data.get("schema_version") == 1
            else None,
            path,
        )
        if sync["last_successful_at"] is not None:
            return sync["last_successful_at"]
    for root in roots:
        path = root / "index.json"
        if not path.exists():
            continue
        data = _read(path)
        if isinstance(data, dict) and data.get("collection_status") == "complete":
            value = data.get("generated_at")
            if not _valid_time(value):
                raise PipelineValidationError(
                    "pipeline",
                    str(path),
                    "sync",
                    "invalid previous collection timestamp",
                )
            return value
    return None


def publish_sync(destination, attempted_at, status, last_successful_at, errors):
    sync = {
        "attempted_at": attempted_at,
        "status": status,
        "last_successful_at": (
            attempted_at if status == "success" else last_successful_at
        ),
        "errors": errors,
    }
    path = Path(destination) / "sync.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=str(path.parent), prefix=".sync.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                {"schema_version": 1, "sync": sync},
                handle,
                ensure_ascii=False,
                allow_nan=False,
            )
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return sync

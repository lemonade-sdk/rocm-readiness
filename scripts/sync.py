"""Read and publish collection synchronization status."""

from datetime import datetime, timezone
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


def load_last_success(destination, previous_data=None):
    roots = [Path(destination)]
    if previous_data is not None and Path(previous_data) != roots[0]:
        roots.append(Path(previous_data))
    for root in roots:
        path = root / "sync.json"
        if not path.exists():
            continue
        data = _read(path)
        sync = (
            data.get("sync")
            if isinstance(data, dict) and data.get("schema_version") == 1
            else None
        )
        good = (
            isinstance(sync, dict)
            and set(sync) == {"attempted_at", "status", "last_successful_at", "errors"}
            and sync.get("status") in ("success", "failed")
            and _valid_time(sync.get("attempted_at"))
            and (
                sync.get("last_successful_at") is None
                or _valid_time(sync["last_successful_at"])
            )
            and isinstance(sync.get("errors"), list)
        )
        good = good and all(
            isinstance(error, dict)
            and set(error) == {"source_id", "record", "field", "reason"}
            and all(isinstance(value, str) for value in error.values())
            for error in sync.get("errors", [])
        )
        good = good and (
            sync["status"] != "success"
            or (
                sync["last_successful_at"] == sync["attempted_at"]
                and not sync["errors"]
            )
        )
        if not good:
            raise PipelineValidationError(
                "pipeline", str(path), "sync", "invalid sync metadata"
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

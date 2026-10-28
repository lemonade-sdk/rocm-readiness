"""Run the same tests and ingestion locally and in GitHub Actions."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys

if __package__:
    from .collect import write_json
    from .sync import load_last_success, publish_sync
    from .validation import PipelineValidationError
else:
    from collect import write_json
    from sync import load_last_success, publish_sync
    from validation import PipelineValidationError


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=root / "sources.json")
    parser.add_argument("--output-dir", type=Path, default=root / "data")
    parser.add_argument("--previous-data", type=Path)
    args = parser.parse_args()
    attempted_at = datetime.now(timezone.utc).isoformat()

    tests = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
    print("Running pipeline tests", flush=True)
    result = subprocess.run(tests, cwd=root, check=False)
    if result.returncode:
        errors = [
            PipelineValidationError(
                "pipeline",
                "",
                "tests",
                f"test suite exited with status {result.returncode}",
            ).diagnostic
        ]
        last_success = None
        try:
            last_success = load_last_success(args.output_dir, args.previous_data)
        except PipelineValidationError as error:
            errors.append(error.diagnostic)
        sync = publish_sync(
            args.output_dir, attempted_at, "failed", last_success, errors
        )
        write_json(args.output_dir / "errors.json", {"errors": errors})
        write_json(
            args.output_dir / "index.json",
            {
                "schema_version": 2,
                "generated_at": attempted_at,
                "collection_status": "degraded",
                "errors": errors,
                "sync": sync,
                "versions": [],
            },
        )
        return result.returncode

    collection = [
        sys.executable,
        str(root / "scripts/collect.py"),
        "--sources",
        str(args.sources.resolve()),
        "--output-dir",
        str(args.output_dir.resolve()),
    ]
    if args.previous_data:
        previous_index = json.loads(
            (args.previous_data / "index.json").read_text(encoding="utf-8")
        )
        if previous_index.get("attribution_version") == 2:
            collection.extend(["--previous-data", str(args.previous_data.resolve())])
        else:
            print(
                "Rebuilding performance attribution from source without previous data",
                flush=True,
            )
    print(f"Collecting dataset into {args.output_dir.resolve()}", flush=True)
    return subprocess.run(collection, cwd=root, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())

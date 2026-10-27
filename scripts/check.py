"""Run the same tests and ingestion locally and in GitHub Actions."""

import argparse
from pathlib import Path
import subprocess
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path, default=root / "sources.json")
    parser.add_argument("--output-dir", type=Path, default=root / "data")
    parser.add_argument("--previous-data", type=Path)
    args = parser.parse_args()

    tests = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
    print("Running pipeline tests", flush=True)
    result = subprocess.run(tests, cwd=root, check=False)
    if result.returncode:
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
        collection.extend(["--previous-data", str(args.previous_data.resolve())])
    print(f"Collecting dataset into {args.output_dir.resolve()}", flush=True)
    return subprocess.run(collection, cwd=root, check=False).returncode


if __name__ == "__main__":
    sys.exit(main())

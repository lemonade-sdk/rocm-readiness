# ROCm Readiness

A static dashboard data pipeline for ROCm engine qualification and model performance.
CI collects producer feeds and publishes finalized JSON to the `dashboard-data` branch.
The app reads `latest.json`, then the dataset pinned to its immutable commit.

```sh
uv run --no-project --python 3.12 python scripts/check.py --output-dir data/local-preview
```

This is the same test-and-ingestion command Actions runs. Inspect the generated
`index.json` and `rocm/` files in the output directory. To carry a previous
collection forward:

```sh
uv run --no-project --python 3.12 python scripts/check.py --output-dir data/next-preview --previous-data data/local-preview
```

Use `uv` to run the commands above with Python 3.12. The collector has no
third-party runtime dependencies and supports Python 3.9+. The collector
writes `data/index.json`, per-version build and model-performance overviews,
monthly build history, and source
copies under `data/raw/`. Use `--previous-data <directory>` to carry forward an
earlier complete dataset, including assigned model measurements and package evidence.
The authenticated GitHub CLI (`gh`) retrieves evidence for newly observed stable
benchmark runs; verified backfill mappings are included in the repository.
Final JSON is committed to the data branch; raw files and logs stay in CI artifacts.
See [the data contract](docs/data-pipeline.md)
for extraction rules, source inventory, limitations, and onboarding.

GitHub Actions runs tests and live collection on PRs, pushes to `main`, daily at
11:17 UTC, and manual dispatch. Download the `readiness-data-*` artifact from the
run; fetch/validation details appear in its logs and summary. A source failure
makes the job fail while preserving a partial diagnostic artifact. Check
`collection_status` before consuming a dataset. The published `latest.json`
reports the current sync result; local artifacts expose it in `sync.json`. Required
stable association failures stop collection and CI. Trusted main-branch runs
restore history from the data branch and publish updates;
PR runs validate without writing it. Raw files remain in 30-day CI artifacts.
See [data publication](docs/data-publication.md) for bootstrap and recovery.
The web app follows separately.

# ROCm Readiness

A static dashboard data pipeline for ROCm engine qualification and model performance.
The first stage collects producer feeds; the website and hosting follow separately.

```sh
uv run --no-project --python 3.12 python -m unittest discover -s tests -v
uv run --no-project --python 3.12 python scripts/collect.py --sources sources.json --output-dir data
```

Use `uv` to run the commands above with Python 3.12. The collector has no
third-party runtime dependencies and supports Python 3.9+. The collector
writes `data/output.json` and commit-pinned source snapshots under `data/raw/`.
Generated datasets and logs are not committed. See [the data contract](docs/data-pipeline.md)
for extraction rules, source inventory, limitations, and onboarding.

GitHub Actions runs tests and live collection on PRs, pushes to `main`, daily at
11:17 UTC, and manual dispatch. Download the `readiness-data-*` artifact from the
run; fetch/validation details appear in its logs and summary. A source failure
makes the job fail while preserving a partial diagnostic artifact. Check
`collection_status` before consuming a dataset. This workflow does not publish
GitHub Pages or write back to producer repositories.

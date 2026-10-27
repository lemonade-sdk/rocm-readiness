# ROCm Readiness

A static dashboard data pipeline for ROCm engine qualification and model performance.
The first stage collects producer feeds; the website and hosting follow separately.

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
writes `data/index.json`, per-version overviews, monthly build history, and source
copies under `data/raw/`. Use `--previous-data <directory>` to carry forward an
earlier complete dataset.
Generated datasets and logs are not committed. See [the data contract](docs/data-pipeline.md)
for extraction rules, source inventory, limitations, and onboarding.

GitHub Actions runs tests and live collection on PRs, pushes to `main`, daily at
11:17 UTC, and manual dispatch. Download the `readiness-data-*` artifact from the
run; fetch/validation details appear in its logs and summary. A source failure
makes the job fail while preserving a partial diagnostic artifact. Check
`collection_status` before consuming a dataset. The workflow carries build history forward from the latest successful main run.
Site publishing follows separately.

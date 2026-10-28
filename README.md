# ROCm Readiness

A data pipeline for ROCm engine qualification and model performance. GitHub Actions
collects producer feeds and publishes JSON under `main/data/`. The dashboard UI is
the next stage.

## Run locally

Requires `uv` and an authenticated GitHub CLI (`gh`) for benchmark package evidence.

```sh
uv run --no-project --python 3.12 python scripts/check.py --output-dir data/local-preview
```

This runs the tests and collection used by CI. To reuse an earlier dataset, add
`--previous-data data/local-preview` and choose a different output directory.
The preview includes source copies and diagnostics that are excluded from publication.

Actions runs on PRs, main pushes, manual dispatch, and daily at 11:17 UTC. Its
`readiness-data-*` artifacts are retained for 30 days. Main runs publish successful
data; failed runs preserve the last good pointer and report errors in sync status.

- [Data flow](docs/data-flow.md): ingestion and dashboard-loading diagrams.
- [Data pipeline](docs/data-pipeline.md): source setup, adapters, channels, and package mappings.
- [Data publication](docs/data-publication.md): runtime files, comparisons, and ROCm directory names.

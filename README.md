# ROCm Readiness

A data pipeline for ROCm engine qualification and model performance. GitHub Actions
collects producer feeds and publishes JSON under `main/data/`. It includes stable
ROCm llama.cpp builds and their benchmark results.

## Run locally

Requires `uv` and an authenticated GitHub CLI (`gh`) for benchmark package evidence.

```sh
uv run --no-project --python 3.12 python scripts/check.py --output-dir data/local-preview
```

This runs the tests and collection used by CI. To reuse an earlier dataset, add
`--previous-data data/local-preview` and choose a different output directory.
Use `--fresh` to rebuild from producer feeds without reusing previous records.
PR checks use this mode. The preview includes source copies and diagnostics for inspection.

Actions runs on PRs, main pushes, manual dispatch, and a daily schedule. Its
`readiness-data-*` artifacts are retained for 30 days. Main runs publish successful
data; failed runs preserve the last good pointer and report errors in sync status.

- [Data flow](docs/data-flow.md): ingestion and published-file diagrams.
- [Data pipeline](docs/data-pipeline.md): source setup, adapters, channels, and package mappings.
- [Data publication](docs/data-publication.md): runtime files and ROCm directory names.
- [Dashboard UI](ui/README.md): local browser preview, static build and UI checks.

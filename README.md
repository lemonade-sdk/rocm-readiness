# ROCm Readiness

A data pipeline for ROCm engine qualification and model performance. GitHub Actions
collects producer feeds and publishes JSON under `main/data/`. It includes stable
ROCm llama.cpp builds and their benchmark results.

The dashboard has two views of that dataset. **ROCm readiness** shows each
engine's builds and model performance for a ROCm version, with stable and
nightly channels. **Upstream health** shows Radeon and Ryzen AI CI in each
project's own repository on its default branch, configured in
[sources.json](sources.json). See [Upstream health](docs/upstream-health.md).

## Run locally

Requires `uv` and an authenticated GitHub CLI (`gh`) for benchmark package evidence.

```sh
uv run --no-project --python 3.12 python scripts/check.py --output-dir data/local-preview
```

This runs the tests and collection used by CI. Set `GH_TOKEN` so the upstream
view can read projects' GitHub Actions; `UPSTREAM_API_BUDGET` caps its calls. To reuse an earlier dataset, add
`--previous-data data/local-preview` and choose a different output directory.
Use `--fresh` to rebuild from producer feeds without reusing previous records.
PR checks use this mode. The preview includes source copies and diagnostics for inspection.

Actions runs on PRs, main pushes, manual dispatch, and a daily schedule. Its
`readiness-data-*` artifacts are retained for 30 days. Main runs publish successful
data; failed runs preserve the last good pointer and report errors in sync status.

- [Data flow](docs/data-flow.md): ingestion and published-file diagrams.
- [Data pipeline](docs/data-pipeline.md): source setup, adapters, channels, and package mappings.
- [Upstream health](docs/upstream-health.md): sources.json, collection rules, the upstream badge and local runs.
- [Data publication](docs/data-publication.md): runtime files and ROCm directory names.
- [JSON reference](docs/reference/README.md): field contracts, source mappings, and validation.
- [Dashboard UI](ui/README.md): local browser preview, static build and UI checks.

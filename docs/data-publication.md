# Data publication

The [workflow](../.github/workflows/collect-data.yml) publishes generated JSON to
`main/data/`. Source configuration is described in [data pipeline](data-pipeline.md);
[data flow](data-flow.md) shows ingestion and dashboard loading.

## App entry point

Read [latest.json](https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json),
then load its `index_url`. This URL pins the dataset to one Git commit. Resolve
all other dataset paths relative to that index URL. Refresh by reading the pointer
again. `latest.json.sync` reports the latest ingestion status and any errors.

## Published files

| Path under `data/` | Contents / when to load |
| --- | --- |
| `latest.json` | Dataset pointer and current sync status; startup and refresh |
| `index.json` | Available ROCm versions, overview paths, and `default_version` |
| `rocm/<version>/overview.json` | Latest builds and performance summaries for the selected version |
| `rocm/<version>/history/<month>.json` | Build records for a month; browsing build history |
| `rocm/<version>/performance.json` | Model measurements and hardware; opening full performance history |
| `performance/comparisons.json` | Empty in the current stable-only scope |
| `sync.json` | Dataset sync metadata, also present in its index; available to tools |

Build records link to detailed reports in the producer repository through
`report_url`. Full performance files exist only for versions with measurements.
Source copies, standalone errors, and intermediate caches stay in CI artifacts.

## Comparisons and version directories

`performance/comparisons.json` is an empty schema-compatible file in the current
stable-only dataset; the index reports its count as zero. No Vulkan or HRX
llama.cpp results are ingested. Comparing ROCm versions uses their per-version
performance files.

Version directories come from in-scope builds and measurements. Stable llama.cpp
packages label versions such as `10.0` and `10.1`; vLLM contributes its own version
labels. Previously ingested nightly/experimental llama.cpp measurements and the
version directories supported only by those measurements are removed during
regeneration. History is retained only when it still matches the configured
sources and selected performance forks.

## Publishing and recovery

Main runs stage final JSON on a temporary branch, squash it into `main`, and update
`latest.json` in the same push. The pointer names the data commit. A concurrent
change rejects the push; a failed collection keeps the previous pointer and updates
sync status. PR runs only validate and upload artifacts.

After fixing a failed source, rerun the workflow. To roll back, restore a verified
pointer and its matching index URL from Git history while publication is stopped.

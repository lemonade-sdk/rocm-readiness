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
| `performance/comparisons.json` | Vulkan and HRX measurements and hardware; opening backend comparisons |
| `sync.json` | Dataset sync metadata, also present in its index; available to tools |

Build records link to detailed reports in the producer repository through
`report_url`. Full performance files exist only for versions with measurements.
Source copies, standalone errors, and intermediate caches stay in CI artifacts.

## Why comparisons.json exists

This file holds benchmark results for backends outside the ROCm version groups.
Use its Vulkan records as a baseline for comparing ROCm performance on the same
model, workload, quantization, and hardware. Filter by `backend: "vulkan"`;
HRX is a separate comparison backend. The index's `comparison_performance`
entry gives the file path and record count.

Comparing two ROCm versions instead uses each version's own performance data.

## Why both 10.1 and 10.1.0 exist

Directory names currently follow two producer naming formats:

| Directory | Package / SDK labels in the current data |
| --- | --- |
| `rocm/10.1/` | Stable llama.cpp packages explicitly labeled `rocm-10.1` |
| `rocm/10.1.0/` | Nightly/experimental SDKs `10.1.0a20260822` and `10.1.0a20260910`, grouped by their numeric prefix |

`10.1.0/` does **not** establish that these SDKs are a final ROCm 10.1.0 release.
The grouping removes the alpha/date suffix; each measurement's `runtime_version`
retains the full SDK identifier. The collector does not treat these SDKs as
identical to the stable `10.1` packages. This is the current naming convention,
not evidence of two distinct final releases.

## Publishing and recovery

Main runs stage final JSON on a temporary branch, squash it into `main`, and update
`latest.json` in the same push. The pointer names the data commit. A concurrent
change rejects the push; a failed collection keeps the previous pointer and updates
sync status. PR runs only validate and upload artifacts.

After fixing a failed source, rerun the workflow. To roll back, restore a verified
pointer and its matching index URL from Git history while publication is stopped.

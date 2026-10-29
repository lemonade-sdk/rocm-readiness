# Data publication

The [workflow](../.github/workflows/collect-data.yml) publishes generated JSON to
`main/data/`. Source configuration is described in [data pipeline](data-pipeline.md);
[data flow](data-flow.md) shows ingestion and published file relationships.

## Dataset entry point

Read [latest.json](https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json),
then load its `index_url`. This URL pins the dataset to one Git commit. Resolve
all other dataset paths relative to that index URL. Refresh by reading the pointer
again. `latest.json.sync` reports the latest ingestion status and any errors.

## Published files

| Path under `data/` | Contents |
| --- | --- |
| `latest.json` | Publisher-written bookmark: points to the last successful dataset's commit/index and reports the newest ingestion attempt's status. |
| `index.json` | Collector-written catalog: available ROCm versions, default selection, source status, build counts, and overview paths. |
| `rocm/<version>/overview.json` | Summary for one ROCm version: engine cards, latest builds, latest model measurements, and paths to full history. |
| `rocm/<version>/history/YYYY-MM.json` | All retained build records for that version and calendar month, including engine, channel, date, qualification results, and evidence links. |
| `rocm/<version>/performance.json` | Model measurement history and hardware for one ROCm version, with workload, metrics, and verified package associations. |
| `sync.json` | Standalone ingestion status for this dataset: attempt time, success/failure, last successful time, and errors. The index embeds the same status. |

Build records link to detailed reports in the producer repository through
`report_url`. Full performance files exist only for versions with measurements.
Source copies, standalone errors, and intermediate caches stay in CI artifacts.

## History grouping and retention

Builds are grouped into one file per ROCm version per calendar month. All October
builds go into `history/2026-10.json`; November builds go into `history/2026-11.json`.
Daily runs add or update records within the monthly file.

A history directory has several files when its builds span several months.
Published history carries forward across successful runs. The 30-day expiry
applies to downloadable CI artifacts containing source copies and diagnostics.

## Version directories

Comparing ROCm versions uses their per-version performance files.

Version directories group the configured builds and measurements by ROCm version.
Stable llama.cpp packages label versions such as `7.14`, `10.0`, and `10.1`.
Each build record identifies its engine and channel; the directory groups records
by ROCm version. History is retained when it
matches the configured sources and selected performance forks.

## Publishing and recovery

Main runs stage final JSON on a temporary branch, squash it into `main`, and update
`latest.json` in the same push. The pointer names the data commit. A concurrent
change rejects the push; a failed collection keeps the previous pointer and updates
sync status. PR runs only validate and upload artifacts.

After fixing a failed source, rerun the workflow. To roll back, restore a verified
pointer and its matching index URL from Git history while publication is stopped.

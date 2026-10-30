# Data publication

The [workflow](../.github/workflows/collect-data.yml) publishes generated JSON to
`main/data/`. Source configuration is described in [data pipeline](data-pipeline.md);
[data flow](data-flow.md) shows ingestion and published file relationships.

See the [JSON reference](reference/README.md) for file schemas, field mappings,
valid examples and validation rules.

## Dataset entry point

Read [latest.json](https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json),
then load its `index_url`. This URL pins the dataset to one Git commit. Resolve
all other dataset paths relative to that index URL. Refresh by reading the pointer
again. `latest.json.sync` and the live `main/data/sync.json` report the latest
ingestion attempt and any errors. Files read through the pinned index URL describe
that successful dataset, including its original sync status.

## Published files

| Path under `data/` | Contents |
| --- | --- |
| `latest.json` | Publisher-written bookmark: points to the last successful dataset's commit/index and reports the newest ingestion attempt's status. |
| `index.json` | Collector-written catalog: available ROCm versions, default selection, source status, build counts, and overview paths. |
| `rocm/<version>/overview.json` | Summary for one ROCm version: engine cards, latest builds, latest model measurements, and paths to full history. |
| `rocm/<version>/history/YYYY-MM.json` | All retained build records for that version and calendar month, including engine, channel, date, qualification results, and evidence links. |
| `rocm/<version>/performance.json` | Model measurement history and hardware for one ROCm version, with workload, metrics, and verified package associations. |
| `sync.json` | Live ingestion status: attempt time, success/failure, last successful time, and errors. Updated alongside `latest.json` on success and failure. |
| `upstream/overview.json` | Upstream health: one card per configured project with its computed badge, per-job daily aggregates, merge gate and platforms. Referenced from `index.json` `upstream`. See [Upstream health](upstream-health.md). |
| `upstream/<project>/ci/YYYY-MM.json` | Every retained default-branch job execution for that project and month, with result, failing step, queue wait, links and merge verdict. |

Build records link to detailed reports in the producer repository through
`report_url`. Full performance files exist only for versions with measurements.
Source copies, standalone errors, and intermediate caches stay in CI artifacts.

## Qualification evidence

The qualification adapter reads the producer's `qualification/index.json` at one
pinned commit. It retains the following fields in build records:

| Fields | Producer input and use |
| --- | --- |
| `build_id`, `tag`, `artifact`, `rocm_version`, `os`, `generated_at` | Index row identity, package and date; `ubuntu`/`win` normalize to `linux`/`windows`. |
| `qualified`, `version_qualified`, `overall`, `tests` | Producer qualification decisions and test counters; warnings and skipped checks remain distinct. |
| `results` | Index per-test status map for summary evidence. |
| `upstream_sha`, `event`, `run_id`, `run_attempt` | Producer source revision and workflow provenance, distinct from benchmark run identifiers. |
| `gfx`, `gfx_target`, `hardware_validated` | Compiled-target summary and recorded hardware validation. |
| `report_url`, `source_url`, `source_pointer` | Absolute pinned report URL, producer index URL and original row pointer. |

Older retained records can lack optional provenance or per-test fields. Missing
fields remain unknown. The UI reads full reports on demand from the pinned
`report_url` for test names, tiers, gating, durations, failure/warning details and
runtime/compatibility evidence. It preserves the feed build identity when reading
reports, whose internal build ID uses a different format. The producer's
`latest/` convenience copies are not a separate ingestion source.

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
change rejects the push. A failed collection updates live `latest.json` and
`sync.json` while retaining the previous data pointer and dataset files.
PR runs rebuild from producer feeds into a fresh output directory and upload the
result as a CI artifact.

After fixing a failed source, rerun the workflow. To roll back, restore a verified
pointer and its matching index URL from Git history while publication is stopped.

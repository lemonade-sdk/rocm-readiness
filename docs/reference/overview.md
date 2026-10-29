# ROCm overview

`data/rocm/<version>/overview.json` is written by
`scripts/dataset.py::_write_version()` with schema version **2**. The catalog's
version entry points to it. It is a summary of the retained version partition,
not a copy of an upstream `latest` file.

| Pointer | Type / presence | Source and rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `2` | Writer constant. |
| `/generated_at` | timestamp string, required | Same collector attempt time as the catalog. |
| `/rocm_version` | version string, required | Must equal its catalog entry and directory. |
| `/engines` | array of engine cards, required | Only configured engines with at least one build or measurement in this version. |
| `/engines/*/id`, `/engines/*/label`, `/engines/*/platforms` | string, string, array of strings; required | Copy the matching configured engine. |
| `/engines/*/build_count` | nonnegative integer, required | Number of retained builds owned by this engine in this version. A measurement-only engine has zero builds. |
| `/engines/*/latest_builds` | array of [build records](history.md), required | Newest retained build per `(channel, os, gfx_target)` group within this engine/version. |
| `/history` | array of chunk entries, required | Nonempty monthly build chunks, newest month first. |
| `/history/*/month` | `YYYY-MM` string, required | Calendar month of build `generated_at`. |
| `/history/*/path` | relative path string, required | `rocm/<version>/history/<month>.json`. |
| `/history/*/build_count` | nonnegative integer, required | Number of build records in that chunk. |
| `/performance` | object, required | One of the two forms below. |
| `/performance/status` | string, required | `not_measured` or `available`. |
| `/performance/measurement_count` | positive integer, required when available | Number of retained assigned measurement records in the linked performance file, after identity deduplication. |
| `/performance/path` | relative path string, required when available | `rocm/<version>/performance.json`. |
| `/performance/latest_measurements` | array of [measurement records](performance.md), required when available | Newest observation per `(engine, channel, model, scenario, quant, system_id)` group. |

When `status` is `not_measured`, the performance object contains only that
property and there is no linked performance file. A measurement date/build is
not a test of the newest qualification build.

## Selection rules

Build identity is `(source_id, build_id)`. A current row replaces its prior row;
other in-scope rows survive. For each engine's latest-build group, choose the
maximum tuple of parsed `generated_at`, `run_attempt`, `source_id`, and `build_id`.
The last two strings provide deterministic ties. Sort groups by string forms of
channel, OS and GPU target. The writer does not filter latest selection to
qualified builds: a newest failure remains visible.

Latest measurement selection compares parsed `measured_at`. On a timestamp tie,
the first encountered retained record wins. Group keys separate hardware IDs,
model, scenario and quantization; no fastest-model or best-throughput choice is
made. Full records and dates remain available in the performance file.

An engine card is omitted when both its build and measurement collections are
empty. Therefore a catalog's configured-engine count can exceed the number of
cards for one version.

## Example

A measurement-free version's overview can be empty before any build is retained:

```json
{
  "schema_version": 2,
  "generated_at": "2026-10-29T19:00:00Z",
  "rocm_version": "10.1",
  "engines": [],
  "history": [],
  "performance": {"status": "not_measured"}
}
```

Normal catalog construction lists only versions with builds or measurements.
For a populated source-to-overview example, see [pinned lineage](mappings.md).

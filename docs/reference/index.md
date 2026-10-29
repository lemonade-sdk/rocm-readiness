# Dataset catalog

`data/index.json` is written by `scripts/dataset.py::write_dataset()` and completed
with sync status by `scripts/collect.py::collect()`. The publisher removes each
source's artifact-only `snapshot` property before committing it. Schema version
is **2** and the current package association contract is `attribution_version: 2`.

| Pointer | Type / presence | Source and rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `2` | Writer constant. |
| `/attribution_version` | integer, required; `2` | Writer constant; verified package attribution. |
| `/generated_at` | timestamp string, required | Collector attempt time, not the newest producer date. |
| `/collection_status` | string, required | `complete` in a publishable dataset; local failed artifacts may say `degraded`. |
| `/engines` | array of engine objects, required | Copies [configuration engine metadata](sources.md); catalog lists configured engines even when a version has no corresponding card. |
| `/sources` | array of source-state objects, required | Per-feed collection/provenance metadata below. |
| `/reference_model` | JSON value, required | Configuration value copied unchanged; null when absent. |
| `/default_version` | ROCm version string or null, required | First version in numeric descending version order, or null for an empty catalog. |
| `/versions` | array of version entries, required | Union of versions with retained in-scope builds or assigned measurements, in numeric descending order. |
| `/versions/*/rocm_version` | string, required | Dotted nonnegative integer version components, e.g. `10.1`. |
| `/versions/*/overview` | relative path string, required | `rocm/<version>/overview.json`. |
| `/versions/*/build_count` | nonnegative integer, required | Count of retained, merged, in-scope build records for this version across engines. |
| `/stable_performance` | object, required | Stable llama.cpp measurement partition counts below. |
| `/stable_performance/assigned_count` | nonnegative integer, required | Number of retained records with engine `llamacpp` and channel `stable` in all per-version performance files. |
| `/stable_performance/awaiting_evidence_count` | integer, required; `0` | Current writer rejects missing stable package evidence rather than publishing an unassigned stable partition. |
| `/sync` | object, required in collected/published catalog | [Attempt-status object](sync.md), describing this dataset's successful attempt. |
| `/errors` | array of diagnostics, optional | Collection failure artifact only; [sync diagnostic shape](sync.md). |

The generic writer can also emit optional `/comparison_performance` with required
integer `count` and relative `path: "performance/comparisons.json"` for configured
non-ROCm comparison records. Current `sources.json` selects stable ROCm llama.cpp
only, so current published catalogs omit it. Its file uses the
[performance envelope](performance.md), but comparison records have null ROCm,
runtime, qualification-build and package fields; they cannot claim ROCm
attribution. Legacy `/unassigned_performance` is accepted only by restoration,
not by current publication.

## Source-state fields

These properties are produced by `scripts/collect.py::collect()`, not the
producer's catalog. Every state has the first six fields. Successfully fetched
states add provenance and freshness metadata. An unavailable state can include
configured location fields without a resolved commit or URL.

| Pointer under `/sources/*` | Type / presence | Source and rule |
| --- | --- | --- |
| `/id`, `/engine`, `/channel`, `/adapter` | strings, required | Copy the corresponding configured source values. |
| `/status` | string, required | `fresh`, `stale`, `empty`, `awaiting_data`, or `error`. |
| `/record_count` | nonnegative integer, required | Selected normalized rows before history merging and measurement identity deduplication; zero when unfetched/empty. |
| `/include_forks` | array of strings, optional | Copy the configured selection when present. |
| `/repository`, `/ref` | strings, required after source resolution; optional otherwise | Configured producer location. |
| `/path` | string, optional | Configured entry path recorded for an unfetched source; successful source's path is represented by `/url`. |
| `/commit` | lowercase 40-character SHA string, required after resolution | Resolved producer commit. |
| `/url` | HTTPS string, required after resolution | Raw producer entry URL at `/commit`. |
| `/sha256` | lowercase 64-character digest string, required after successful fetch | SHA-256 of collector's serialized source snapshot, rather than a checksum of arbitrary upstream HTTP formatting. |
| `/latest_observation_at` | timestamp string or null, required after normalization | Maximum selected build `generated_at` or measurement `measured_at`; null when empty. |
| `/age_hours` | number or null, required after normalization | `(attempt time − newest observation) / 3600`, rounded to two decimals; null when empty; future timestamps fail validation. |
| `/stale_after_hours` | positive number, required after normalization | Configuration threshold. |
| `/destination` | string, required after normalization | Qualification `rocm/*/history/*.json` or performance `rocm/*/performance.json`. |
| `/snapshot` | relative path string, optional, artifact only | `raw/<source-id>.json`; removed from committed catalog. |
| `/error` | string, optional | Failure text on a degraded artifact. |
| `/diagnostic` | object, optional | Structured [diagnostic](sync.md) on a degraded artifact. |

Nonempty feeds are `stale` only when unrounded age exceeds the configured
threshold, otherwise `fresh`. A stale feed is still a successfully validated
source. `record_count` is not interchangeable with a version's retained
`build_count` or `measurement_count`.

## Example

This valid empty catalog illustrates all required catalog fields without
embedding version files:

```json
{
  "schema_version": 2,
  "attribution_version": 2,
  "generated_at": "2026-10-29T19:00:00Z",
  "collection_status": "complete",
  "engines": [{"id": "llamacpp", "label": "llama.cpp", "platforms": ["linux", "windows"]}],
  "sources": [],
  "reference_model": null,
  "default_version": null,
  "versions": [],
  "stable_performance": {"assigned_count": 0, "awaiting_evidence_count": 0},
  "sync": {
    "attempted_at": "2026-10-29T19:00:00Z",
    "status": "success",
    "last_successful_at": "2026-10-29T19:00:00Z",
    "errors": []
  }
}
```

See [field lineage](mappings.md) for version ordering, retained-history identity,
and independently pinned examples.

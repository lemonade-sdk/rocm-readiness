# Model measurements and hardware

`data/rocm/<version>/performance.json` is written by
`scripts/dataset.py::_write_version()` with schema version **2**. Its overview's
`performance.path` links to it only when retained assigned measurements exist.

| Pointer | Type / presence | Rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `2` | Writer constant. |
| `/measurements` | array of measurement records, required | All retained assigned observations in this version, after identity merging. |
| `/systems` | array of system records, required | Only systems referenced by those measurements, unique by `(source_id, id)`. |

## Measurement record

All listed fields are emitted by the current writer. Nullable means null is
preserved rather than estimated. Types below describe current normalized
producer input; retained legacy fields are not all revalidated by the adapter.
For example, historical identity validation accepts integer quantization values
and does not reapply the adapter's positive-context-size check. `runtime_version` is optional in older restored
records; current records emit null when a stable package filename supplies ROCm.

| Field under `/measurements/*` | Type / nullability | Mapping |
| --- | --- | --- |
| `source_id` | string | Configured benchmark source ID. |
| `source_pointer` | JSON-pointer string | Original latest/history record location. |
| `kind` | string | `latest` for `by_model_scenario`; `history` for producer history. It identifies source location, not freshness of the retained row. |
| `engine`, `channel`, `backend`, `engine_repository` | strings | Configured mapping for the selected producer `fork_id`; producer `fork_repo` and `backend`, when present, must agree. |
| `fork_id` | string | Latest record's `fork_id`, or fork key in producer history. |
| `engine_version` | string | Producer `fork_version` for latest records, `version` for history; identifies engine package tag, never the benchmark run ID. |
| `model`, `scenario` | strings | Latest record fields or enclosing producer history object keys. |
| `quant` | string or null in current normalization | Producer quantization label; restored legacy measurement identities also accept integer quantization values. |
| `system_id` | string or null | Producer `hw_id`, joined to the source-scoped system ID; may be versioned to preserve a changed hardware identity. |
| `context_size` | positive integer or null | Producer `ctx_size`; no scenario-name inference. |
| `input_tokens` | nonnegative integer or null | Producer workload input token count. |
| `measured_at` | timestamp string | Producer `timestamp`, independent of collector or latest build date. |
| `run_id` | digit string or nonnegative integer | Benchmark workflow ID, checked against `run_url`. |
| `run_url` | GitHub Actions HTTPS string | Benchmark producer repository's `/actions/runs/<run_id>`. |
| `lemonade_version` | string or null | Producer client version when present. |
| `metrics` | object, required | Current adapter emits the seven metric fields below; retained legacy metric objects can be partial. |
| `rocm_version` | version string | Verified package identity; not copied from a nullable producer leaderboard `rocm_version`. |
| `qualification_build_id` | string or null | Exact unique package/engine/tag/version/platform qualification match; null when none. |
| `accuracy_verdict` | null | No qualification-derived model-answer verdict is created. |
| `producer_accuracy` | object or legacy null | Current adapter emits five nullable producer accuracy fields below; retained legacy objects can be partial. |
| `source_url` | pinned raw GitHub HTTPS string | Benchmark entry URL at the resolved producer commit. |
| `package_url` | GitHub release asset HTTPS string | Exact package established by benchmark job evidence or saved verified association. |
| `package_os` | string | Package filename's normalized platform (`linux` or `windows` for stable packages). |
| `runtime_version` | string or null | Exact release runtime label when the package requires release-body evidence; null for stable versioned filenames. |
| `attribution` | object | Verified evidence and match status below. |

### Metrics and producer accuracy

Metrics are copied from the same-named producer properties into `/metrics`.
They must be finite nonnegative numbers. `tps_mean` and `ttft_ms_mean` are required
numbers in selected source records; the other metric values can be null.

| Metric | Unit / meaning |
| --- | --- |
| `tps_mean`, `tps_p95` | Tokens per second, producer mean and 95th percentile. |
| `tg_tps` | Token generation tokens per second. |
| `ttft_ms_mean`, `ttft_ms_best` | Time to first token, milliseconds. |
| `pp_tps` | Prompt processing tokens per second. |
| `vram_peak_gb` | Peak VRAM, GB as reported by producer. |

`producer_accuracy` copies nullable `accuracy` (number in `[0,1]`),
`accuracy_passed`, `accuracy_total`, `accuracy_deviations` (nonnegative integers),
and `accuracy_pass` (boolean). The current adapter emits every key, including
nulls. Saved legacy records can have null or partial `producer_accuracy`; missing
properties remain unknown. These producer values remain separate from package
qualification and `accuracy_verdict`.

### Attribution object

| Field under `/measurements/*/attribution` | Type / presence | Rule |
| --- | --- | --- |
| `status` | string, required | `matched` when exactly one qualification build matches, otherwise `rocm_identified`. |
| `package_url` | string, required | Same exact package URL as the measurement. |
| `evidence_url` | string, required | Benchmark `/actions/runs/<run_id>/job/<job_id>` evidence URL. |
| `log_sha256` | lowercase 64-character digest string, required | Checksum of the retrieved benchmark job log used for package evidence. |
| `reason` | string, optional | `no matching qualification build` when unmatched; removed on a match. |
| `job_evidence` | array of job objects, optional | Per-attempt job evidence retained when available. |
| `runtime_evidence` | object, optional | Required when package filename lacks a ROCm version and release runtime evidence is used. |

Each `job_evidence` object has required digit-string `job_id`, `package_url`,
`evidence_url`, and `log_sha256`. Optional `method` is `download_log` or
`cached_binary_registry_match`. Cached matches also contain `registry_evidence`
with required pinned raw-GitHub `url`, source JSON `body` string, and `sha256`.
The registry must identify the same engine/fork/tag and its exact Linux package.
`runtime_evidence` likewise contains required GitHub release API `url`, release
`body` string and `sha256`. Its unique `**ROCm Version**:` line supplies the
runtime label; an alpha suffix is retained in `runtime_version` while the numeric
prefix groups the ROCm version. All evidence hashes are checked before reuse.

## System record

These fields are emitted under `/systems/*`; missing producer properties become
null. `id` and `source_id` are non-null strings. Measurements join using both.

| Field | Type / nullability | Mapping |
| --- | --- | --- |
| `id` | string | Producer system ID, or suffixed identity described below. |
| `source_id` | string | Configured benchmark source ID. |
| `cpu`, `gpu`, `os` | strings or null | Same-named producer system properties. |
| `gpu_full` | string, array of GPU objects, or null | Producer detailed GPU metadata. Each object requires string `name`; optional nullable `type` string, `integrated` boolean, and finite nonnegative `vram_gb` number. Other producer subproperties are preserved. |
| `memory` | producer JSON value or null | Same-named producer metadata, preserved without interpretation. |
| `ram_gb`, `vram_gb` | finite nonnegative numbers or null | Same-named producer memory capacities. |
| `source_pointer` | JSON-pointer string | Original producer `/systems/<index>`. |
| `gfx_target` | producer JSON value or null | Same-named producer metadata, preserved without synthesizing it from `gpu`. |

If a producer reuses a system ID for changed metadata within a ROCm version,
the writer preserves the older system and assigns the changed one
`<producer-id>--<sha256>`. The digest covers sorted compact JSON of all projected
system fields except `id` and `source_pointer`. This prevents historical records
from silently switching hardware.

## Retention and package matching

Measurement identity is `(source_id, fork_id, engine_version, model, scenario,
quant, measured_at, run_id)`. Duplicate latest/history occurrences merge into one
record, preferring the latest occurrence and filling missing `system_id`,
`context_size`, and `input_tokens` from its matching history. The same fields and
known producer accuracy can survive from an identical saved measurement.
Other in-scope saved observations remain retained.

The benchmark run identifies measurement evidence. The downloaded package
identifies engine tag, repository, platform and ROCm version. A qualification
match additionally requires exact engine, repository, tag, ROCm version, OS and
artifact filename. More than one match fails validation. No match still retains
the measured package with `rocm_identified`, never a fabricated build ID.

## Example

The example below is the empty schema envelope. Published per-version files are
created only when measurements exist; [pinned lineage](mappings.md#benchmark-and-package-example)
shows a real nonempty measurement and its exact association.

```json
{"schema_version": 2, "measurements": [], "systems": []}
```

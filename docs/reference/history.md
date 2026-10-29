# Build history

`data/rocm/<version>/history/YYYY-MM.json` is written by
`scripts/dataset.py::_write_version()`. Schema version is **2**. The overview's
`history` entries identify these files and their record counts.

| Pointer | Type / presence | Source and rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `2` | Writer constant. |
| `/rocm_version` | version string, required | Must equal the version directory, overview and every build's version. |
| `/month` | `YYYY-MM` string, required | Calendar month of every build's parsed `generated_at` timestamp, using that timestamp's recorded offset. |
| `/builds` | array of build records, required | Retained in-scope records sorted by newest selection key first. |

## Build record

The table applies to `/builds/*` in a history file and `/engines/*/latest_builds/*`
in an overview. Newly compacted records emit every field below, using null for
missing optional values. Restored older records may omit `artifact`, `results`,
`upstream_sha`, `event`, or `run_id`; their absence remains unknown. All other
properties are required when restoring schema-v2 history.

| Field | Type / nullability | Source and transformation |
| --- | --- | --- |
| `source_id` | nonempty string | Configured source `id`. |
| `build_id` | nonempty string | Producer index row `build_id`; qualification feed identity, not an internal full-report ID or a benchmark run ID. |
| `engine` | string | Configured source engine. |
| `tag` | string | Producer engine release tag; multiple ROCm/OS packages can share it. |
| `artifact` | string or null | Producer package filename; a matching retained record can supply a previously known filename when the current row omits it. |
| `rocm_version` | version string | Producer row's ROCm version, checked before grouping. |
| `channel` | string | Configured `stable`/`nightly`, or the validated producer value for `from-record`. |
| `os` | string | Producer row OS, falling back to source OS; `ubuntu` → `linux`, `win` → `windows`. Valid normalized values are `linux`, `windows`, `macos`. |
| `gfx_target` | string or null | Producer hardware-validation target; separate from compiled-target coverage. |
| `hardware_validated` | boolean or null | Producer flag, without inferring validation from compiled targets. |
| `gfx` | object or null | Producer compiled-target summary: optional nullable nonnegative integer `requested`/`present`, optional nullable string-array `missing`. Other producer subproperties are preserved. |
| `qualified` | boolean | Producer qualification decision; not recalculated from test counters. |
| `version_qualified` | boolean or null | Producer version-level qualification decision. |
| `overall` | string | Producer `pass`, `warn`, or `fail`. |
| `generated_at` | timestamp string | Producer build/report date, not collector time. |
| `run_attempt` | nonnegative integer | Producer workflow attempt. |
| `tests` | object of nonnegative integer counters | Producer counters; required source counters are `passed`, `failed`, `total`; keys such as `warned`, `skipped`, `missing` remain separate when supplied. |
| `blocked_by` | array of strings or null | Producer blocking reasons. |
| `blocking_tests` | array of strings or null | Producer direct field, falling back to `summary.blocking_tests` when direct field is null/absent. |
| `report_url` | absolute HTTPS string | Producer relative `reports/...` path resolved against the pinned qualification index URL. |
| `run_url` | absolute HTTPS string | Producer qualification workflow URL. |
| `source_pointer` | JSON-pointer string | Original index position, e.g. `/builds/1`. |
| `source_url` | pinned raw GitHub HTTPS string | Actual source index URL including its resolved 40-character commit. |
| `results` | object or null | Producer test ID → `pass`, `warn`, `fail`, `skip`, or `missing`; keys are preserved. |
| `upstream_sha` | lowercase 40-character SHA string or null | Producer's engine source revision, distinct from the qualification-data commit in `source_url`. |
| `event` | string or null | Producer workflow event. |
| `run_id` | string or null | Producer qualification workflow run identifier. |

## Retention and identity

`(source_id, build_id)` uniquely identifies a retained build. A current row
replaces the same prior identity; other prior rows survive only while matching
the configured source repository, engine and channel. Sources marked
`awaiting_data` are excluded. History is merged only for a complete collection.
An explicit empty current feed does not erase prior in-scope history.

Grouping follows `generated_at`, not collection time or the build tag. Builds
are sorted descending by parsed timestamp, attempt number, source ID, and build
ID. Monthly and engine counts are computed from these merged records.

## Example

This record is the normalized Linux `b11997` example from the
[pinned qualification source](mappings.md#pinned-producer-samples).

```json
{
  "schema_version": 2,
  "rocm_version": "10.1",
  "month": "2026-10",
  "builds": [{
    "source_id": "llamacpp-stable-qualification",
    "build_id": "40870439417-ubuntu-rocm-10.1",
    "engine": "llamacpp",
    "tag": "b11997",
    "artifact": "llama-b11997-bin-ubuntu-rocm-10.1-x64.tar.gz",
    "rocm_version": "10.1",
    "channel": "stable",
    "os": "linux",
    "gfx_target": "gfx1151",
    "hardware_validated": true,
    "gfx": {"requested": 27, "present": 27, "missing": []},
    "qualified": true,
    "version_qualified": true,
    "overall": "pass",
    "generated_at": "2026-10-29T16:11:22Z",
    "run_attempt": 1,
    "tests": {"passed": 16, "failed": 0, "warned": 0, "skipped": 1, "missing": 0, "total": 17},
    "blocked_by": [],
    "blocking_tests": [],
    "report_url": "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/55cc3a880c1635ab08c7bd115538886fe60ae6be/qualification/reports/40870439417-ubuntu-rocm-10.1.json",
    "run_url": "https://github.com/lemonade-sdk/llama.cpp/actions/runs/40870439417",
    "source_pointer": "/builds/1",
    "results": {"T0.1":"pass","T0.2":"pass","T0.3":"pass","T0.4":"pass","T0.5":"pass","T0.6":"pass","T0.7":"pass","T0.8":"pass","T0.9":"skip","T0.10":"pass","T0.11":"pass","T0.12":"pass","T1.1":"pass","T1.2":"pass","T1.3":"pass","T1.4":"pass","T1.5":"pass"},
    "upstream_sha": "0ac1a7fd35c127a18c0cbc6c57d12e256a6a385b",
    "event": "schedule",
    "run_id": "40870439417",
    "source_url": "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/55cc3a880c1635ab08c7bd115538886fe60ae6be/qualification/index.json"
  }]
}
```

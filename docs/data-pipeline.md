# Data pipeline

[sources.json](../sources.json) lists the feeds. [scripts/collect.py](../scripts/collect.py)
fetches them, validates their fields, and maps them into the dashboard dataset.
See [data flow](data-flow.md) for the overview and [data publication](data-publication.md)
for the published files. [JSON reference](reference/README.md) provides
field types, nullability and [producer mappings](reference/mappings.md).

## Published release discovery

`views.readiness.release_repositories` in [sources.json](../sources.json) sets
the [stable repository](https://github.com/lemonade-sdk/llama.cpp/releases) and
the [nightly repository](https://github.com/lemonade-sdk/llamacpp-rocm/releases).
The collector reads uploaded ROCm binary archives from published releases. It
takes the stable SDK version from the archive filename and the exact nightly SDK
version from the release's ROCm Version field.

The first run paginates through both release histories. Later runs restore
`release-inventory.json`, paginate through new observations until they reach
the previous first release, and merge those observations by repository and tag.
If the marker has disappeared, the scan continues through the full history.
A weekly full scan picks up changes on older releases beyond the marker.
The collector fetches each proposed release by tag again to check its archives.
If a release has been removed or has lost its binaries, the collector recomputes
the selection. A discovery request failure fails the collection and preserves
the last successful publication. A successful scan with fewer eligible nightlies
publishes the available tracks.

The dashboard selects the latest published release in the highest numeric
stable minor track, then the latest published release in each of the first two
available newer nightly minor tracks in numeric order. An older nightly can
remain eligible while its binaries are published. The CI log lists observed
tracks, selected tags and qualification coverage for each release.

Qualification joins by repository, channel, exact SDK version, tag and archive.
The collector uses the pinned qualification feed when it contains a matching
report. If the feed is unavailable or has no matching entry, it checks the release-attached report and verifies its tag,
SDK version and archive. When neither provides evidence, the dashboard keeps the
download links and shows “Qualification data unavailable.” Qualification and
performance records are rebuilt from current producer snapshots.

## Current sources

| Data | Repository / branch | Entry file |
| --- | --- | --- |
| llama.cpp stable qualification | [lemonade-sdk/llama.cpp · qualification-data](https://github.com/lemonade-sdk/llama.cpp/tree/qualification-data) | [qualification/index.json](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/index.json) |
| llama.cpp nightly qualification | [lemonade-sdk/llamacpp-rocm · qualification-data](https://github.com/lemonade-sdk/llamacpp-rocm/tree/qualification-data) | [qualification/index.json](https://github.com/lemonade-sdk/llamacpp-rocm/blob/qualification-data/qualification/index.json) |
| Model performance | [lemonade-sdk/lemonade · benchmark-data](https://github.com/lemonade-sdk/lemonade/tree/benchmark-data) | [leaderboard.json](https://github.com/lemonade-sdk/lemonade/blob/benchmark-data/leaderboard.json) |

llama.cpp ingests stable ROCm builds from `lemonade-sdk/llama.cpp` and their model
results from Lemonade's `benchmark-data` branch. `include_forks: ["llamacpp-rocm-stable"]`
selects those results before association.

## What we retain

| Source | File ingested | Data retained |
| --- | --- | --- |
| `lemonade-sdk/llama.cpp` · `qualification-data` | [qualification/index.json](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/index.json) | Stable build IDs/tags, packages, ROCm/OS, qualification verdicts, test counts, GPU coverage, hardware-validation flags, dates, and evidence links |
| `lemonade-sdk/lemonade` · `benchmark-data` | [leaderboard.json](https://github.com/lemonade-sdk/lemonade/blob/benchmark-data/leaderboard.json) | Stable llama.cpp models, workloads, quantization, throughput/latency/VRAM metrics, hardware, available accuracy results, benchmark dates/run links, and engine tag/package/ROCm associations |

## Adding or changing a source

A source points to one entry file on a producer branch. For example:

```json
{
  "id": "llamacpp-stable-qualification",
  "engine": "llamacpp",
  "repository": "lemonade-sdk/llama.cpp",
  "ref": "qualification-data",
  "path": "qualification/index.json",
  "adapter": "qualification-v1",
  "channel": "stable",
  "stale_after_hours": 72
}
```

`id` uniquely names the feed; `engine` must match an entry in `engines`.
`repository`, `ref`, and `path` locate the JSON. The collector resolves the branch
to a commit before fetching, so links refer to the version it actually read.
`stale_after_hours` marks a feed stale when its newest observation exceeds that age.

### Adapter: how to read the JSON

An adapter is Python code in [scripts/collect.py](../scripts/collect.py), selected
by the `adapter` name. It checks the producer's schema and converts its fields
into build or model-measurement records.

| Adapter | Function | Expected contents |
| --- | --- | --- |
| `qualification-v1` | `normalize_qualification()` | `schema_version: 1` and a `builds` array with build tags, ROCm versions, test results, and report links |
| `lemonade-leaderboard-v1` | `normalize_performance()` | `systems`, `by_model_scenario`, and `history`, containing hardware and model benchmark results |

Choose the adapter by inspecting the producer JSON. Qualification format details:
[llama.cpp schema](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/SCHEMA.md).
A different format requires a new normalizer, registration in `ADAPTERS`, and
fixture tests under [tests/](../tests/).

The qualification index contains build summaries. Each build's `report_url`
points to a deeper JSON report under `qualification/reports/`. The collector
retains each report link alongside its build summary. The leaderboard entry file
contains both latest measurements and history.

### Channel: which build track a result belongs to

Channel labels distinguish release tracks; they are separate from ROCm versions.
Check the producer's release workflow or its record's `channel` field when
configuring a source.

| Source setting | How the result gets its channel |
| --- | --- |
| `stable` or `nightly` | Apply that label to every qualification record in the feed |
| `from-record` | Read each qualification record's `channel` (`stable` or `nightly`) |
| `from-fork` | Look up each benchmark's `fork_id` in the source's `forks` mapping |

Performance fork mappings name the engine, repository, backend, and channel.
The current llama.cpp mapping is `stable` / `rocm` / `lemonade-sdk/llama.cpp`.
`include_forks` lists which producer fork IDs to read; other forks are skipped.
Selected records must match their configured repository and backend.

### Validate the change

1. Edit `sources.json`. Add an `engines` entry if introducing an engine.
   Performance feeds need the `forks` mapping.
2. Run the test-and-ingestion command in the [README](../README.md).
3. Open a PR and inspect its Actions artifact. After merge, the main workflow
   publishes the dataset; daily runs continue using the updated source list.

## Why package mappings are saved

Lemonade's benchmark run ID identifies the measurement job.
[scripts/attribution.py](../scripts/attribution.py) identifies the stable package
used by that job. Its filename supplies the engine tag and ROCm version. Matching
repository, tag, package filename, OS, and ROCm version associates a measurement
with its qualification build. Older measurements keep their verified tag/package
when the producer index no longer lists that build.
Missing or conflicting package evidence fails collection.

The committed [provenance/llamacpp-stable-packages.json](../provenance/llamacpp-stable-packages.json)
is read by the collector for historical stable mappings when rebuilding from
scratch. Normal runs can also reuse
mappings in the previous published dataset.

CI saves source copies and a generated `provenance/packages.json` diagnostic copy
in its artifact. Artifacts expire after 30 days; the
committed mappings and evidence embedded in published measurements survive them.

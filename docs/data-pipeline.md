# Data pipeline

[sources.json](../sources.json) lists the feeds. [scripts/collect.py](../scripts/collect.py)
fetches them, validates their fields, and maps them into the dashboard dataset.
See [data flow](data-flow.md) for the overview and [data publication](data-publication.md)
for the published files.

`sources.json` is maintained here by repository contributors. Its entries locate
the upstream JSON files listed below. Each run combines their current results
with the last successfully published dataset, retaining in-scope history and
previously verified package associations.

## Current sources

| Data | Repository / branch | Entry file |
| --- | --- | --- |
| llama.cpp stable qualification | `lemonade-sdk/llama.cpp` / `qualification-data` | `qualification/index.json` |
| vLLM qualification | `lemonade-sdk/vllm-rocm` / `qualification-data` | `qualification/index.json` |
| Model performance | `lemonade-sdk/lemonade` / `benchmark-data` | `leaderboard.json` |

llama.cpp ingests stable ROCm builds from `lemonade-sdk/llama.cpp` and their model
results from Lemonade's `benchmark-data` branch. `include_forks: ["llamacpp-rocm-stable"]`
selects those results before association. vLLM includes stable/nightly Linux history.

## What we retain

| Source | File ingested | Data retained |
| --- | --- | --- |
| `lemonade-sdk/llama.cpp` · `qualification-data` | `qualification/index.json` | Stable build IDs/tags, packages, ROCm/OS, qualification verdicts, test counts, GPU coverage, hardware-validation flags, dates, and evidence links |
| `lemonade-sdk/vllm-rocm` · `qualification-data` | `qualification/index.json` | Linux stable/nightly build IDs/tags, packages, ROCm versions, qualification summaries, dates, and evidence links |
| `lemonade-sdk/lemonade` · `benchmark-data` | `leaderboard.json` | Stable llama.cpp models, workloads, quantization, throughput/latency/VRAM metrics, hardware, available accuracy results, benchmark dates/run links, and engine tag/package/ROCm associations |

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
[llama.cpp schema](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/SCHEMA.md)
and [vLLM schema](https://github.com/lemonade-sdk/vllm-rocm/blob/qualification-data/qualification/SCHEMA.md).
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
| `from-record` | Read each qualification record's `channel` (`stable` or `nightly`); used by vLLM's mixed history |
| `from-fork` | Look up each benchmark's `fork_id` in the source's `forks` mapping |

Performance fork mappings name the engine, repository, backend, and channel.
The current llama.cpp mapping is `stable` / `rocm` / `lemonade-sdk/llama.cpp`.
`include_forks` lists which producer fork IDs to read; other forks are skipped.
Selected records must match their configured repository and backend.

### Validate the change

1. Edit `sources.json`. Add an `engines` entry if introducing an engine. vLLM
   currently needs `os: "linux"`; performance feeds need the `forks` mapping.
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

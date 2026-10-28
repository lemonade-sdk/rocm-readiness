# Data pipeline

[sources.json](../sources.json) lists the feeds. [scripts/collect.py](../scripts/collect.py)
fetches them, validates their fields, and maps them into the dashboard dataset.
See [data flow](data-flow.md) for the overview and [data publication](data-publication.md)
for the files the app will use.

## Current sources

| Data | Repository / branch | Entry file |
| --- | --- | --- |
| llama.cpp stable qualification | `lemonade-sdk/llama.cpp` / `qualification-data` | `qualification/index.json` |
| vLLM qualification | `lemonade-sdk/vllm-rocm` / `qualification-data` | `qualification/index.json` |
| Model performance | `lemonade-sdk/lemonade` / `benchmark-data` | `leaderboard.json` |

Nightly llama.cpp, Whisper, and Stable Diffusion qualification feeds are marked
`availability: "awaiting_data"` until their producers supply data. ROCm model
performance already includes stable, nightly, and experimental forks.

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
into build or model-measurement records. There is no separate adapter file.

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
reads the index and keeps a link to that report; it does not ingest the full
report. A build-detail view can follow the link. The leaderboard entry file
already contains both latest measurements and history.

### Channel: which build track a result belongs to

Channel labels distinguish release tracks; they are separate from ROCm versions.
Check the producer's release workflow or its record's `channel` field when
configuring a source. The collector does not infer the channel from a build number.

| Source setting | How the result gets its channel |
| --- | --- |
| `stable` or `nightly` | Apply that label to every qualification record in the feed |
| `from-record` | Read each qualification record's `channel` (`stable` or `nightly`); used by vLLM's mixed history |
| `from-fork` | Look up each benchmark's `fork_id` in the source's `forks` mapping |

Performance fork mappings name the engine, repository, backend, and channel.
Current channels are `stable`, `nightly`, `experimental` (alternative forks),
and `reference` (the upstream Vulkan baseline). Match the producer's fork registry,
[src/cpp/resources/benchmark_forks.json](https://github.com/lemonade-sdk/lemonade/blob/main/src/cpp/resources/benchmark_forks.json),
and benchmark records when adding a mapping. An unknown fork fails validation.

### Validate the change

1. Edit `sources.json`. Add an `engines` entry if introducing an engine. vLLM
   currently needs `os: "linux"`; performance feeds need the `forks` mapping.
2. Run the test-and-ingestion command in the [README](../README.md).
3. Open a PR and inspect its Actions artifact. After merge, the main workflow
   publishes the dataset; daily runs continue using the updated source list.

## Why package mappings are saved

Build tags alone do not identify the ROCm package used by a benchmark.
[scripts/attribution.py](../scripts/attribution.py) checks job downloads or cached
binary records and package release metadata. It saves the package URL, SDK version,
and supporting links in each measurement. Missing or conflicting evidence fails
collection. A qualification link additionally requires an exact matching artifact.

The committed [provenance/llamacpp-stable-packages.json](../provenance/llamacpp-stable-packages.json)
is read by the collector for historical stable mappings when rebuilding from
scratch. It is an input, not the generated CI cache. Normal runs can also reuse
mappings in the previous published dataset.

CI saves source copies and a generated `provenance/packages.json` diagnostic copy
in its artifact. Neither is published. Artifacts expire after 30 days; the
committed mappings and evidence embedded in published measurements survive them.

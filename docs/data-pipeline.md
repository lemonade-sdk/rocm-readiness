# Data pipeline

The collector reads `sources.json`, fetches the latest data from each configured
branch, and prepares files for the dashboard. See the [data flow](data-flow.md).

## Sources

| Data | Repository / branch | Path |
| --- | --- | --- |
| llama.cpp stable qualification | `lemonade-sdk/llama.cpp` / `qualification-data` | `qualification/index.json` |
| vLLM qualification | `lemonade-sdk/vllm-rocm` / `qualification-data` | `qualification/index.json` |
| Model performance | `lemonade-sdk/lemonade` / `benchmark-data` | `leaderboard.json` |

Nightly llama.cpp, Whisper, and Stable Diffusion qualification feeds are pending.
Their entries use `availability: "awaiting_data"` and are not fetched. vLLM is
Linux-only; its existing records include historical stable and nightly builds.

Producer qualification schemas: [llama.cpp](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/SCHEMA.md),
[vLLM](https://github.com/lemonade-sdk/vllm-rocm/blob/qualification-data/qualification/SCHEMA.md).

## Adding or changing a source

Each object in the `sources` array tells the collector where to find one feed
and how to read it. This is an existing entry:

```json
{
  "id": "llamacpp-stable-qualification",
  "engine": "llamacpp",
  "adapter": "qualification-v1",
  "repository": "lemonade-sdk/llama.cpp",
  "ref": "qualification-data",
  "path": "qualification/index.json",
  "channel": "stable",
  "stale_after_hours": 72
}
```

| Field | Purpose |
| --- | --- |
| `id` | Unique name for this source |
| `engine` | Which configured engine receives its results |
| `repository` | GitHub repository containing the JSON |
| `ref` | Branch, tag, or commit to read |
| `path` | JSON file path within that repository |
| `adapter` | Existing mapping code for the source's JSON format |
| `channel` | Stable/nightly label, or `from-record` / `from-fork` to read the label from the data or fork configuration |
| `stale_after_hours` | Age after which the newest result is labeled stale |

1. Append another object to `sources` with a different `id`, or edit an existing
   object. The collector processes every entry on each run and combines the results.
2. Open a pull request. Its Actions run validates the configuration and uploads
   a preview dataset for review.
3. Merge the pull request. A main-branch run collects the updated sources immediately;
   subsequent daily runs use the same updated list.

For an existing engine and supported format, only `sources.json` changes. A new
engine also needs an entry in `engines`; a new JSON format needs mapping code and
fixture tests. Some formats need extra settings: vLLM supplies `os: "linux"`, and
the benchmark feed uses `forks` to map backend variants. Both examples are in
[sources.json](../sources.json).

## Generated files

The UI dataset uses schema version 2:

```text
data/
├── index.json
├── rocm/<version>/
│   ├── overview.json
│   └── history/<month>.json
├── performance/unassigned.json
└── raw/<source>.json
```

- `index.json` lists ROCm versions, overview paths, source status, and collection time.
- Each overview contains engine cards, latest builds for each channel/OS/GPU target,
  build counts, and links to monthly history chunks.
- History chunks contain compact build records: build number, version, date,
  platform, qualification verdict, counts, coverage, and evidence links.
- `report_url` opens the producer's full build report when details are requested.
- Performance records awaiting reliable ROCm attribution live in `unassigned.json`.
  Each version's overview identifies its performance coverage.
- `raw/` contains source copies for inspection in the Actions artifact. Records
  retain their source identity and JSON location; historical builds also carry
  the original source URL at the revision that supplied them.

The browser loads the version index and selected overview first. Browsing builds
loads a history chunk; opening a build loads its report. A comparison loads the
other version's overview. Model, workload, quantization, and hardware establish
which measurements can be compared.

## History across runs

`--previous-data <directory>` carries build history forward from a complete dataset.
New records update matching `(source_id, build_id)` entries; older records and
ROCm versions remain available. The collector projects only the fields used by
the UI. Each monthly file groups many builds.

Actions restores the latest successful main-branch dataset before ingestion.
Each successful run carries that history into its new artifact. Artifacts are
retained for 30 days; after an interruption longer than retention, restore a
saved dataset before resuming the history chain. Performance history follows
the observations currently supplied by the benchmark feed.

## Status and evidence

Sources report `fresh`, `stale`, `empty`, `awaiting_data`, or `error`. The initial
freshness threshold is 72 hours, measured from the newest observation. Each build
retains its own date and the producer's `qualified` verdict. Release qualification,
compiled GPU coverage, and hardware validation remain separate fields.

A failed source produces an error status and a `degraded` diagnostic dataset;
the command exits 1. Complete collections produce datasets suitable for publishing.
Unsupported schemas, future timestamps, unknown forks, and invalid hardware
references fail validation. Upstream accuracy observations remain separate from
an agreed readiness accuracy verdict.

Actions runs `scripts/check.py`, the same test-and-ingestion entry point used
locally. It runs on PRs, main pushes, manual dispatch, and daily at 11:17 UTC. Each run
logs fetched sources, validation, record counts, and generated destinations. The
job summary and downloadable artifact provide the run's evidence. Site publishing
and browser views are the next implementation stage.

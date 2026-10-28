# Data pipeline

The collector reads `sources.json`, fetches the latest data from each configured
branch, and prepares files for the dashboard. See the [data flow](data-flow.md).

## Sources

| Data | Repository / branch | Path |
| --- | --- | --- |
| llama.cpp stable qualification | `lemonade-sdk/llama.cpp` / `qualification-data` | `qualification/index.json` |
| vLLM qualification | `lemonade-sdk/vllm-rocm` / `qualification-data` | `qualification/index.json` |
| Model performance | `lemonade-sdk/lemonade` / `benchmark-data` | `leaderboard.json` |

The initial integration covers llama.cpp stable builds and their model performance.
Nightly llama.cpp, vLLM integration, Whisper, and Stable Diffusion are tracked as
[P1 follow-ups](https://github.com/lemonade-sdk/rocm-readiness/issues?q=is%3Aissue+label%3Astatus%3Aawaiting-data).
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

Local/CI output uses dataset schema version 2. The publication step retains the
final files described in [data publication](data-publication.md):

```text
data/
├── index.json
├── sync.json
├── errors.json
├── rocm/<version>/
│   ├── overview.json
│   ├── history/<month>.json
│   └── performance.json
├── performance/comparisons.json
├── provenance/packages.json
└── raw/<source>.json
```

- `index.json` lists ROCm versions, overview paths, source status, and collection time.
- `sync.json` exposes the latest attempt, its result, the last successful sync, and
  affected-source errors. The same `sync` object appears in `index.json`.
- `errors.json` records each failure's source, JSON location, field, and reason.
- Each overview contains engine cards, latest builds for each channel/OS/GPU target,
  build counts, and links to monthly history chunks.
- History chunks contain compact build records: build number, version, date,
  platform, qualification verdict, counts, coverage, and evidence links.
- `report_url` opens the producer's full build report when details are requested.
- Each version's `performance.json` contains assigned model measurements and hardware.
  Its overview includes the latest measurements and the path to their history.
- `provenance/packages.json` preserves the package evidence used for attribution.
- `performance/comparisons.json` contains only non-ROCm measurements (`vulkan` and
  `hrx`) and their hardware. The root `comparison_performance` entry supplies its
  `path` and `count`. These measurements have no ROCm version or qualification
  association. An empty comparisons file is valid.
- Every ROCm measurement must have a verified package identity and ROCm version.
  Missing or ambiguous evidence fails collection for stable, nightly, and
  experimental channels; there is no unassigned output or guessed version.
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

Actions restores the last published dataset from `main/data/`. Final build/model records preserve history and verified attribution without
raw files or intermediate evidence caches. The latest pointer identifies one
immutable dataset commit in `main`. See [data publication](data-publication.md).

Raw source copies, logs, errors files, and intermediate evidence stay in CI
artifacts for 30 days. They provide diagnostics for that run.

## Model associations

The collector matches each ROCm benchmark run to the exact package downloaded
by its jobs, then derives the ROCm version and platform from that package. It joins
the qualification record using the package, repository, engine tag, platform, and
ROCm version. Measurements retain their ROCm context when an older qualification
record is unavailable. Qualification links require the complete exact identity;
identifying a ROCm version alone never creates a qualification link. Nightly and
experimental packages retain their full runtime version (including alpha/date
suffixes) separately from the numeric ROCm dataset version (for example, `10.3.0a20261027`
is retained as `runtime_version` and grouped under `10.3.0`). Their attribution
must include verified runtime evidence for the downloaded package.

Verified historical mappings are stored in `provenance/llamacpp-stable-packages.json`.
New mappings use the authenticated GitHub CLI (`gh`); Actions supplies its job token.
Each mapping retains job links, log hashes, and the observation timestamps it covers.
Repeated job attempts must agree on the package. Unavailable or ambiguous ROCm evidence
fails collection with the source, record, field, and reason. Available producer accuracy values stay
with the model measurement, separately from build qualification.

## Status and evidence

Sources report `fresh`, `stale`, `empty`, `awaiting_data`, or `error`. The initial
freshness threshold is 72 hours, measured from the newest observation. Each build
retains its own date and the producer's `qualified` verdict. Release qualification,
compiled GPU coverage, and hardware validation remain separate fields.

A failed source produces an error status and a `degraded` diagnostic dataset;
the command exits 1. Required-field, metric, schema, and association errors also
fail collection. Configured future feeds keep their expected awaiting-data status.
Complete collections produce datasets suitable for publishing.
Unsupported schemas, future timestamps, unknown forks, and invalid hardware
references fail validation. Upstream accuracy observations remain separate from
an agreed readiness accuracy verdict.

Actions runs `scripts/check.py`, the same test-and-ingestion entry point used
locally. It runs on PRs, main pushes, manual dispatch, and daily at 11:17 UTC. Each run
logs fetched sources, validation, record counts, and generated destinations. The
job summary and downloadable artifact provide the run's evidence. Trusted main
runs publish finalized JSON; browser views are the next implementation stage.

## Synchronization status

The common `sync` object has `attempted_at`, `status` (`success` or `failed`),
`last_successful_at`, and `errors`. Failed attempts preserve the last successful
time and identify the affected source and field. A failed test gate records the
same status before ingestion.

In published data, the app reads the current `sync` object from `latest.json`.
A failed run updates that status while preserving the pointer to the last good
dataset. The dataset's embedded sync metadata describes its own successful run.

### Cached binaries

Some historical benchmark jobs reused a cached binary. Their package association
is labeled `cached_binary_registry_match` in per-record job evidence, rather than
an observed download. The collector requires the same job's exact fork/tag cache
record, its checked-out registry at a pinned commit, and the matching release
asset. This establishes producer-declared package identity; it does not verify
the cached executable's bytes. Release-body evidence records the declared bundled
SDK, not a measurement of the runner's system ROCm installation.

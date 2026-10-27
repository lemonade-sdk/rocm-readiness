# Data pipeline

The collector reads `sources.json`, fetches each feed at a pinned Git commit, and
writes `data/output.json` plus source snapshots in `data/raw/`.
See the [data flow](data-flow.md) for an overview.

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

## Output

`output.json` uses schema version 1:

| Field | Contents |
| --- | --- |
| `generated_at`, `collection_status` | Collection time and `complete` or `degraded` |
| `engines`, `reference_model` | Card metadata and the fixed model; model selection is pending |
| `sources` | Status, pinned URL/commit, snapshot path/hash, observation time, count, destination |
| `builds` | Qualification records keyed by `(source_id, build_id)` |
| `measurements` | Latest and historical performance records |
| `systems` | Hardware metadata keyed by `(source_id, id)` |

Each record has a `source_id` and JSON `source_pointer` into its raw snapshot.
`sha256` hashes the saved snapshot bytes. Full qualification reports are linked
at the same pinned commit. Consumers read snapshots listed in `output.json`;
local reruns can leave older, unreferenced files in `raw/`.

## Interpretation

- Keep the producer's `qualified` verdict and test counts. Warnings or missing
  tests can coexist with a passing gate. `version_qualified` is a separate release
  gate. Compiled gfx coverage and hardware validation are separate fields.
- Performance `kind` is `latest` or `history`; these can overlap. Filter by kind
  before counting. Missing historical hardware or workload metadata stays null.
- Metric names retain producer units: TPS, milliseconds for TTFT, and GB for VRAM.
- `qualification_build_id` and `rocm_version` stay null: benchmark records do not
  identify a unique qualified archive. A matching engine tag is insufficient.
- `producer_accuracy` retains upstream observations; `accuracy_verdict` stays null
  until the evaluation contract is agreed.
- Compare measurements only when model, quantization, scenario, system, and workload
  match. Missing metadata does not establish comparability.

## Runs and failures

See the [README](../README.md) for `uv` commands. Actions runs on PRs, main pushes,
manual dispatch, and daily at 11:17 UTC. The schedule activates after merge.
Each run logs fetches, validation, counts, and destinations, then uploads a dataset
artifact retained for 30 days. It does not publish Pages or commit generated data.

Source status is `fresh`, `stale`, `empty`, `awaiting_data`, or `error`. Staleness
uses the newest observation, with an initial 72-hour threshold; individual records
can be older. Historical nightly records do not establish current readiness.

Invalid schemas, future timestamps, unknown forks, and invalid hardware references
fail the source. It contributes no normalized records; collection becomes
`degraded` and exits 1. Other sources still run, and Actions uploads the diagnostic
artifact. Inspect the source error and snapshot, correct the configuration or
adapter, and rerun. Stale, empty, and pending feeds do not fail collection.

Every run reads the history currently retained by producers. Artifacts are not a
permanent archive; a producer can prune its own feed.

# Data pipeline and contract (version 1)

## Sources

`sources.json` is the editable inventory. `engines` defines four independent cards:
llama.cpp, vLLM, Whisper, and Stable Diffusion. vLLM has Linux scope. A null
`reference_model` means selection is pending; consumers must not pick the fastest
model automatically.

| Source | Repository / branch | File | Mapping |
| --- | --- | --- | --- |
| Stable llama.cpp qualification | `lemonade-sdk/llama.cpp` / `qualification-data` | `qualification/index.json` | `qualification-v1`, stable; OS from record |
| vLLM qualification | `lemonade-sdk/vllm-rocm` / `qualification-data` | `qualification/index.json` | `qualification-v1`, channel from record; Linux |
| Model performance | `lemonade-sdk/lemonade` / `benchmark-data` | `leaderboard.json` | `lemonade-leaderboard-v1`, engine/channel/backend from `forks` |
| Nightly llama.cpp qualification | Expected producer: `lemonade-sdk/llamacpp-rocm` | Not configured yet | `awaiting_data` |
| Whisper qualification | Producer feed pending | Not configured | `awaiting_data` |
| Stable Diffusion qualification | Producer feed pending | Not configured | `awaiting_data` |

Qualification contracts: [llama.cpp](https://github.com/lemonade-sdk/llama.cpp/blob/qualification-data/qualification/SCHEMA.md)
and [vLLM](https://github.com/lemonade-sdk/vllm-rocm/blob/qualification-data/qualification/SCHEMA.md).
The benchmark source includes ROCm stable, ROCm nightly, Vulkan, and experimental
forks. These are backend variants within llama.cpp, not additional engine cards.

The collector resolves each repository/ref to a commit once per collection, then
fetches files at that SHA. Sources remain owned by their producer repositories.
No producer code executes. Each fetch has a 45-second timeout and at most three
attempts for transient transport/server errors. Each file is bounded to 32 MiB.
`GH_TOKEN` is optional and sent only to GitHub's API for commit resolution, never
embedded in a URL or output file. Public raw files need no credentials.

## Input contract

Top-level `schema_version` is 1, with `engines`, `reference_model`, and `sources`.
Every source has a unique safe `id`, `engine`, named `adapter`, and `channel`.
Active sources also specify `repository`, `ref`, `path`, and positive
`stale_after_hours`. Pending sources use `availability: "awaiting_data"` and are
not fetched. The collector checks configuration before performing network IO.

For `qualification-v1`, `channel` is `stable`, `nightly`, or `from-record`;
`os` supplies a known platform when the producer omits it (vLLM).
For `lemonade-leaderboard-v1`, `channel` is `from-fork` and the `forks` object maps
each producer fork ID to `engine`, `channel`, `backend`, and `repository`.
Unknown forks fail that source instead of silently assigning the wrong engine.

Add a source using an existing format by editing only this metadata. For a new
format, implement a named adapter, add representative fixtures and behavioral
tests, then document its mapping here. To enable a pending feed, remove
`availability`, verify the actual producer contract, and supply repository/ref/path
and freshness threshold. Merely changing a channel label does not establish a feed.

## Output contract

`output.json` contains:

| Field | Meaning |
| --- | --- |
| `schema_version` | Consumer contract version, currently 1 |
| `generated_at` | UTC collection time; not a build publication time |
| `collection_status` | `complete` or `degraded` (at least one active source failed) |
| `reference_model` | Configured fixed model, currently null |
| `engines` | Configured card metadata, including engines with no records |
| `sources` | Fetch status, commit, URL, snapshot path/hash, freshness, count and destination |
| `builds` | Normalized qualification rows, retaining producer fields |
| `measurements` | Latest and historical performance observations |
| `systems` | Producer system metadata, namespaced by `source_id` |

Each source status is `fresh`, `stale`, `empty`, `awaiting_data`, or `error`.
Unknown schema versions are source errors, with the unsupported version recorded
in the error message. Staleness is based on the latest observation timestamp,
not the fetch time or the producer's index generation time. Future-dated observations
fail the source rather than becoming fresh. The initial 72-hour
threshold is an operational display policy, not a qualification gate. Old records
remain in the dataset. Per-record dates are mandatory for scoped views: a fresh
source does not make every record fresh. Historical vLLM nightly records are not
evidence that a current nightly pipeline is operational.

A source error contributes no normalized records, sets `collection_status` to
`degraded`, and makes the CLI exit 1. Other sources can still complete. A diagnostic
artifact is uploaded even after failure. Existing output is replaced with this
collection's result; there is no silent fallback to a previous healthy dataset.
`stale`, `empty`, and expected `awaiting_data` states do not fail collection.

Raw snapshots are parsed JSON reserialized as UTF-8 with indentation and a final
newline. `sha256` hashes those exact artifact bytes, not upstream HTTP bytes.
Records carry `source_id` plus an RFC 6901 `source_pointer` into that snapshot.
The pair traces each normalized record to its raw fields. Snapshot URLs and full
qualification report links are pinned to producer commits; test details can be
loaded from those external report URLs without an unbounded N+1 collection step.

### Qualification mapping

The logical key is `(source_id, build_id)`. All builds in each index are retained;
duplicate IDs within a source are rejected. `win` becomes `windows`, `ubuntu`
becomes `linux`; other producer fields are preserved. `report_url` becomes an
absolute commit-pinned URL. `hardware_validated` is null if unspecified.

Use the producer's boolean `qualified` as the archive verdict. Warnings and
missing-test counts do not override it. `version_qualified` is a separate
release-level gate; a qualified archive can still be withheld from a release.
Never equate qualification with deployment. vLLM can count missing tests as
failed; llama.cpp distinguishes missing from failed. Preserve their counts and
`results` rather than forcing the two count conventions to match. Tests change
over time, so there is no hardcoded test denominator of 17.

Compiled gfx targets are not hardware-tested targets. Keep `gfx`, `gfx_target`,
and `hardware_validated` distinct. No inferred executive readiness rollup ships
in this data foundation: denominators and grouping rules belong in a later change.

### Performance mapping

`by_model_scenario` becomes `kind: "latest"`; `history[model][scenario][fork]`
becomes `kind: "history"`. These overlap by design; filter by `kind` rather than
counting both as independent measurements. `model`, `scenario`, quantization,
context size, input tokens, system ID, engine repository/version, run link and
measurement time accompany the metric values. Historical records retain only
metadata actually supplied in history; missing hardware/context stays null.
`systems` resolves latest measurements' hardware IDs within their source. Duplicate
system IDs and non-null hardware IDs absent from that source's system inventory
fail validation.

`metrics` retains producer names and units: `tps_mean`, `tps_p95`, `tg_tps`, and
`pp_tps` are tokens/sec; `ttft_ms_mean` and `ttft_ms_best` are milliseconds;
`vram_peak_gb` is GB as reported. Missing values remain null, never zero.

`qualification_build_id` and `rocm_version` stay null. An engine tag alone can
match multiple archive/ROCm combinations; benchmark `commit` is the Lemonade
commit, not the engine artifact identity. Do not attach results to qualified
builds based on date, tag, gfx target, or a matching ROCm label alone.

Comparisons require matching model, quantization, scenario, system and workload;
null metadata cannot establish comparability. Previous-build change, nightly
versus stable, and ROCm versus Vulkan remain separate comparison questions.
The collector does not calculate ratios or merge measurement history across systems.

`producer_accuracy` preserves upstream accuracy fields separately. `accuracy_verdict`
remains null until the evaluation/reference contract is agreed. A successful
performance run never implies output correctness. Newly available upstream
accuracy booleans must not automatically become readiness verdicts.

## CI and operations

The collection workflow runs on PRs, main pushes, manual dispatch, and daily at
11:17 UTC (07:17 Eastern daylight time / 06:17 Eastern standard time). This is an
initial fixed UTC schedule; it avoids the top of the hour and is not a promise of
an exact run time. Scheduled workflows activate on the default branch after merge.
Actions needs only `contents: read`; this pipeline uploads artifacts but neither
publishes Pages nor commits datasets. Logs and the job summary stay in the Actions
run. Dataset artifacts, including raw evidence, expire after 30 days. Every run
recollects the full histories currently retained by the producers; it is not an
independent permanent archive if a producer later prunes its feed.

For failure recovery, inspect the named source error, commit, and raw snapshot;
fix an invalid pointer or adapter through a PR, then rerun collection. Do not
consume `degraded` output as a complete dashboard refresh. Downloadable artifacts
are the handoff to the later static app build/deployment pipeline, not a hosted
JSON endpoint yet.

When reusing an output directory locally, old unreferenced raw files can remain
after a fetch failure. Consumers must use only snapshots referenced by the current
`output.json`, never discover sources by scanning `raw/`. Actions starts from a
fresh checkout on every run.

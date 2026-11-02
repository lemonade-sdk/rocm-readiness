# Field lineage and pinned examples

This reference distinguishes **configuration** (maintained in this repository),
**copied** producer evidence, **derived** values, and **saved** history. A source
pointer is interpreted against that record's `source_url`, not against today's
producer branch head.

## Pinned producer samples

| Name used below | Repository / branch | Pinned entry |
| --- | --- | --- |
| Q | `lemonade-sdk/llama.cpp` / `qualification-data` | [`qualification/index.json` at `55cc3a880c1635ab08c7bd115538886fe60ae6be`](https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/55cc3a880c1635ab08c7bd115538886fe60ae6be/qualification/index.json) |
| B | `lemonade-sdk/lemonade` / `benchmark-data` | [`leaderboard.json` at `49ae7ee05232d62b9cd3ace11f37649119226755`](https://raw.githubusercontent.com/lemonade-sdk/lemonade/49ae7ee05232d62b9cd3ace11f37649119226755/leaderboard.json) |

The [pinned fixture manifest](../../tests/fixtures/pinned/manifest.json) records
original JSON pointers and content digests for exact producer subtrees. The
qualification excerpt includes original Q positions `/builds/1`, `/builds/4`,
`/builds/7`, `/builds/10`, and `/builds/25`. Benchmark excerpts include the selected
model's latest group, stable history group and hardware catalog. Offline tests
reconstruct small adapter inputs from those exact fragments; array positions in
a reconstructed excerpt can differ from original producer positions. The
manifest retains the originals.

The [package evidence fixture](../../tests/fixtures/pinned/package-evidence.json)
records a separately retrieved job's metadata, download-line excerpt, and log
digest. Expected tags, counters, dates, metric values, identities and associations
are specified independently in tests, rather than generated from adapter output.

## Configuration and catalog lineage

`C` below denotes `sources.json`; `I` denotes the last-good pinned catalog and its
linked records. Producer revisions come from GitHub's commit API, fetched once
per configured repository/ref pair during `collect()`.

| Input / pointer | Kind and transformation | Destination |
| --- | --- | --- |
| C `/engines`, `/reference_model` | Configuration copied; absent reference model → null | Catalog `/engines`, `/reference_model`; matching engine metadata in overview `/engines/*/{id,label,platforms}` |
| C `/sources/*/{id,engine,adapter,channel,include_forks}` | Configuration copied when applicable | Catalog `/sources/*/{id,engine,adapter,channel,include_forks}` |
| C `/sources/*/{repository,ref,path}` | Configuration plus GitHub commit API `/sha`; construct immutable raw URL | Catalog source `/repository`, `/ref`, `/commit`, `/url`; unfetched sources can retain `/path` |
| Fetched Q or B document | Derived SHA-256 of collector serialization: UTF-8 JSON, indent 2, `ensure_ascii=false`, trailing newline | Catalog source `/sha256`; artifact-only `/snapshot` identifies raw copy |
| Selected Q `/builds/*/generated_at` or normalized B timestamp | Derived maximum timestamp and age at collector clock | Catalog source `/latest_observation_at`, `/age_hours` |
| C source `/stale_after_hours` and selected records | Configuration threshold; empty → `empty`; otherwise unrounded age over threshold → `stale`, else `fresh` | Catalog source `/stale_after_hours`, `/status` |
| C source `/availability: awaiting_data` | Configuration; no fetch, zero records | Catalog source `/status: awaiting_data`, `/record_count: 0` |
| Selected normalized records | Derived pre-retention count; latest/history duplicates can both contribute | Catalog source `/record_count` |
| Adapter type | Derived destination label | Catalog source `/destination` |
| Collector clock | Derived attempt timestamp | Catalog `/generated_at`; every overview `/generated_at`; successful sync `/attempted_at` and `/last_successful_at` |
| Retained in-scope builds and assigned measurements | Derived union of version strings, ordered by integer version components descending; lexical version string breaks equal-component ties | Catalog `/versions/*/rocm_version`, `/default_version` |
| Each retained version | Derived relative path | Catalog `/versions/*/overview` |
| Retained builds in a version | Derived count after identity merge/filtering | Catalog `/versions/*/build_count` |
| Retained assigned records across versions | Derived count where engine=`llamacpp`, channel=`stable` | Catalog `/stable_performance/assigned_count` |
| Writer constants | Derived format/contract identifiers and zero unresolved count | Catalog `/schema_version: 2`, `/attribution_version: 2`, `/stable_performance/awaiting_evidence_count: 0`; version-file `/schema_version: 2` |
| Collector source/association errors | Derived `complete`/`degraded` and structured diagnostics | Catalog `/collection_status`; failed-artifact `/errors`; [sync fields](sync.md) |

Current successful committed catalogs have no artifact `snapshot` links. Raw
source files, package-cache diagnostics and standalone errors remain artifacts.

## Qualification field map

Let `q` be one Q `/builds/<i>` object and `h` be its output history
`/builds/<j>` object. Exactly the same compact record can appear in overview
`/engines/<e>/latest_builds/<k>`. All rows use `normalize_qualification()` followed
by `_compact_build()`.

| Input pointer | Kind and transformation/default | Destination pointer |
| --- | --- | --- |
| C matching source `/id`, `/engine` | Configuration copied | h `/source_id`, `/engine` |
| C matching source `/channel` | Configuration copied; `from-record` instead reads q `/channel` | h `/channel` |
| q `/build_id`, `/tag`, `/artifact`, `/rocm_version`, `/generated_at` | Copied; absent artifact → null, or saved matching artifact as below | h same-named fields |
| q `/qualified`, `/version_qualified`, `/overall`, `/run_attempt`, `/tests` | Copied; absent nullable version verdict → null; test counters remain producer values | h same-named fields |
| q `/os`, or C source `/os` fallback | Derived alias: `ubuntu`→`linux`, `win`→`windows`; otherwise validated OS unchanged | h `/os` |
| q `/gfx_target`, `/hardware_validated`, `/gfx` | Copied, absent → null | h same-named fields |
| q `/blocked_by`, `/blocking_tests` | Copied, absent → null; q `/summary/blocking_tests` fallback only when direct blocking-tests value is null/absent | h `/blocked_by`, `/blocking_tests` |
| q `/report_url` | Derived absolute URL via resolution against Q pinned entry URL | h `/report_url` |
| q `/run_url` | Copied qualification workflow URL | h `/run_url` |
| q `/results`, `/upstream_sha`, `/event`, `/run_id` | Copied; absent optional provenance → null in current compact records | h same-named fields |
| Q pinned entry URL | Derived from configured producer location and resolved commit | h `/source_url` |
| Original Q index `<i>` | Derived original record JSON pointer `/builds/<i>` | h `/source_pointer` |
| I matching `(source_id, build_id)` | Saved rows survive if still in scope; current rows replace identity matches. Saved artifact fills a current null artifact only when engine/tag/version/OS and producer repository agree | Retained h record or `/artifact` |

The source-data commit in `source_url`, the engine source `upstream_sha`, the
producer feed `build_id`, and the qualification workflow `run_id` are different
identities. Full reports use their own internal IDs; the feed ID is preserved
when following `report_url`.

### Qualification example

At Q `/builds/1`, `build_id` is
`40870439417-ubuntu-rocm-10.1`, tag is `b11997`, OS is `ubuntu`, and date is
`2026-10-29T16:11:22Z`. The destination is ROCm `10.1`, month `2026-10`, normalized
OS `linux`, with `16` passed, `0` failed and `1` skipped of `17` tests. Producer
`qualified: true` is copied; the writer does not turn `16/17` into its own verdict.
Q `/builds/4` is the separate Windows package for the same release tag, with
`13` passed, `1` warning and `3` skipped. Equal release tags do not make the
package/build identities equal.

The five-row excerpt has five distinct qualification feed identities, so its
single-version catalog and overview count is **5** after merging those rows
alone. The latest Linux and Windows groups are `b11997`, selected by timestamp
and tie-break rules, not by their tag numbers. The full producer feed and saved
history can have different counts; excerpt counts are test expectations, not
production totals.

## Benchmark field map

Let `b` be a selected B latest entry at
`/by_model_scenario/<group>/<i>`, or history entry at
`/history/<model>/<scenario>/<fork>/<i>`. Let `m` be output
`/measurements/<j>` in `rocm/<verified-version>/performance.json`. Summary
`/performance/latest_measurements/*` embeds the same measurement shape.

| Input pointer | Kind and transformation/default | Destination pointer |
| --- | --- | --- |
| C benchmark source `/include_forks` | Configuration filter before attribution; unselected forks are skipped | Determines which B rows can create m records |
| C benchmark source `/id` | Configuration copied | m `/source_id`; system `/source_id` |
| b `/fork_id` for latest, enclosing history fork key otherwise | Copied identity; must exist in configured fork map | m `/fork_id` |
| C `/sources/*/forks/<fork>/{engine,channel,backend,repository}` | Configuration copied; when supplied b `/fork_repo` and `/backend` must agree | m `/engine`, `/channel`, `/backend`, `/engine_repository` |
| b `/fork_version` for latest or `/version` for history | Copied engine tag | m `/engine_version` |
| b `/model`, `/scenario` for latest, enclosing history keys otherwise | Copied model/workload identity | m `/model`, `/scenario` |
| b `/quant`, `/hw_id`, `/ctx_size`, `/input_tokens` | Copied or null; rename hardware/context fields | m `/quant`, `/system_id`, `/context_size`, `/input_tokens` |
| b `/timestamp`, `/run_id`, `/run_url`, `/lemonade_version` | Copied; missing client version → null | m `/measured_at`, `/run_id`, `/run_url`, `/lemonade_version` |
| b `/tps_mean`, `/tps_p95`, `/tg_tps`, `/ttft_ms_mean`, `/ttft_ms_best`, `/pp_tps`, `/vram_peak_gb` | Copied into metric object; optional absent values → null | m `/metrics/<same-name>` |
| b `/accuracy`, `/accuracy_passed`, `/accuracy_total`, `/accuracy_deviations`, `/accuracy_pass` | Copied; absent → null | m `/producer_accuracy/<same-name>` |
| Adapter constant | Derived null, without inferring answer correctness from package checks | m `/accuracy_verdict` |
| B pinned URL and original record location | Derived evidence identity | m `/source_url`, `/source_pointer` |
| B `/systems/<s>/{id,cpu,gpu,gpu_full,os,memory,ram_gb,vram_gb,gfx_target}` | Copied projection; absent nullable metadata → null | Referenced output `/systems/*/<same-name>` |
| Original B system position `<s>` | Derived source JSON pointer | Output system `/source_pointer: /systems/<s>` |
| I identical measurement identity | Saved hardware/context/input/accuracy values can fill absent fields; current non-null values are not guessed or replaced with scenario-derived settings | m metadata and referenced saved systems |

The source's nullable `rocm_version` is not used as stable package evidence.
The benchmark run ID remains the benchmark run ID. ROCm assignment and
qualification association use the separate evidence map below.

### Package and association map

| Input evidence | Kind and transformation | Destination |
| --- | --- | --- |
| Benchmark `run_url`, `run_id`, fork, engine tag and measured date | Derived evidence lookup; require matching run/fork/tag and job time or observed measurement-time membership | Package association eligibility |
| Benchmark job's exact download line, or verified cached binary registry at the benchmark checkout commit | Copied exact release asset URL; all available matching attempts must agree | m `/package_url`, `/attribution/package_url`; job evidence fields |
| Stable package URL `.../releases/download/<tag>/llama-<tag>-bin-(ubuntu\|win)-rocm-<version>-x64.(tar.gz\|zip)` | Derived repository/tag/OS/version; check repository/tag against configured benchmark identity | m `/package_os`, `/rocm_version` |
| Job metadata/log | Copied evidence URL and derived log digest | m `/attribution/evidence_url`, `/attribution/log_sha256`; optional `/job_evidence` |
| Release body when asset filename lacks runtime version | Copied checksummed release evidence and parsed unique ROCm version label | m `/runtime_version`, `/attribution/runtime_evidence`; numeric ROCm grouping |
| I identical verified measurement, same source repository and compatible represented hardware/workload | Saved previously validated package/evidence when no new candidate exists; conflicting evidence fails | m package and attribution fields |
| Retained Q build rows | Derived unique match on engine, producer repository, engine tag, ROCm version, package OS and exact artifact filename | m `/qualification_build_id`; attribution `/status: matched` |
| No exact Q match | Derived null; package identity is still preserved | m `/qualification_build_id: null`; attribution `/status: rocm_identified`, `/reason` |

Multiple exact qualification matches or conflicting package evidence fail the
mapping. Association never substitutes a benchmark workflow ID for an engine
build ID.

### Benchmark and package example

B `/by_model_scenario/Gemma-4-26B-A4B-it-GGUF|context-32k/3` identifies stable
`b11932`, benchmark run **40537509555**, measured **2026-10-27T19:12:45Z**.
Its `ctx_size` is **32768**, input is **24035** tokens, quantization is `Q4_K_M`,
and hardware points to B `/systems/1` via
`AMD RYZEN AI MAX+ 395 w/ Radeon 8060S|0.5|linux`.
Its copied generation rate is **36.65 tokens/s** and mean first-token latency is
**21471.51 ms**. The matching history entry is
`/history/Gemma-4-26B-A4B-it-GGUF/context-32k/llamacpp-rocm-stable/4`.
Those duplicate latest/history occurrences produce one retained observation.

The separately retrieved [benchmark job](https://github.com/lemonade-sdk/lemonade/actions/runs/40537509555/job/122306719689)
records this exact downloaded asset:

```text
https://github.com/lemonade-sdk/llama.cpp/releases/download/b11932/llama-b11932-bin-ubuntu-rocm-10.1-x64.tar.gz
```

The asset establishes ROCm **10.1** and platform **linux**, even though the
leaderboard's `rocm_version` is null. Q `/builds/25` matches its repository, tag,
ROCm version, platform and artifact filename. The output
`qualification_build_id` is **40501231559-ubuntu-rocm-10.1**, and attribution status
is `matched`. It is neither the measurement run **40537509555** nor the newest
qualification build **40870439417-ubuntu-rocm-10.1**.

## Derived overview/history values

| Input | Kind and exact derivation | Destination |
| --- | --- | --- |
| Merged in-scope builds | Derived grouping by `rocm_version` and recorded calendar month of `generated_at` | History `/rocm_version`, `/month`, `/builds`; overview history `/month`, `/path` |
| Each monthly group | Derived length | Overview `/history/*/build_count` |
| Configured engine and retained version records | Derived presence: emit a card only if this engine has a build, performance measurement or execution attempt | Overview `/engines` |
| Retained builds owned by that engine/version | Derived length | Overview `/engines/*/build_count` |
| Engine/version builds grouped by `(channel, os, gfx_target)` | Derived maximum of `(parsed generated_at, run_attempt, source_id, build_id)` | Overview `/engines/*/latest_builds` |
| Retained assigned measurements for one version | Derived length and relative path; no rows → only `status: not_measured` | Overview `/performance/{status,measurement_count,path}` |
| Measurements grouped by `(engine, channel, model, scenario, quant, system_id)` | Derived newest parsed `measured_at`; timestamp tie preserves first encountered row | Overview `/performance/latest_measurements` |
| Referenced `(source_id, system_id)` pairs | Derived subset of source-scoped systems, preserving historical hardware identities | Performance `/systems` |

## Pointer and status lineage

| Input | Kind and transformation | Destination |
| --- | --- | --- |
| Successful validated dataset commit | Derived Git SHA and raw index URL | Live pointer `/data_commit`, `/index_url` |
| Collection attempt time/result/errors | Derived attempt status; successful time equals attempt time | `/sync` in successful catalog, pointer and sync file |
| Failed collection or publication attempt | Derived failure diagnostics and current attempt time; saved last successful time | Live pointer `/sync`, live sync-file `/sync` |
| Last published pointer after a failure | Saved without changing dataset identity | Live pointer `/data_commit`, `/index_url`; pinned dataset records stay unchanged |
| File-format constants | Derived `schema_version: 1` | Pointer and sync-file `/schema_version` |

The immutable data commit contains its successful catalog/sync snapshot. Later
live status changes do not mutate that commit. Conformance and publication tests
check both the manifest relationships and failure preservation; agreement among
only the writer and its own summaries is not treated as source-mapping proof.

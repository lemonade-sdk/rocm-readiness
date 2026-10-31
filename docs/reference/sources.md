# Source configuration

[`sources.json`](../../sources.json) is repository-maintained configuration,
read and checked by `scripts/config.py::load_config()`. It is not generated
by a producer. Its canonical schema version is **2**; schema version 1 remains
supported for readiness-only inputs. The table below describes readiness feeds.

| Pointer | Type / presence | Meaning |
| --- | --- | --- |
| `/schema_version` | integer, required; `2` | Configuration format. |
| `/reference_model` | JSON value, optional | Copied unchanged to the dataset catalog; defaults to null when absent. Current configuration uses null. |
| `/engines` | array of engine objects, required | Configured engine metadata. |
| `/engines/*/id` | string, required, unique | Engine identity used by sources, builds and measurements. |
| `/engines/*/label` | string, required by UI | Display label. |
| `/engines/*/platforms` | array of strings, required by UI | Supported platform labels, e.g. `linux`, `windows`. |
| `/sources` | array of source objects, required | Feeds and their selection rules. |
| `/sources/*/id` | string, required, unique | Lowercase letters/digits/hyphens; first character alphanumeric. |
| `/sources/*/engine` | string, required | Must name a configured engine. |
| `/sources/*/adapter` | string, required | `qualification-v1` or `lemonade-leaderboard-v1`. |
| `/sources/*/channel` | string, required | `stable`, `nightly`, `from-record`, or `from-fork`; current fetched qualification uses `stable`, performance uses `from-fork`. |
| `/sources/*/availability` | string, optional | Defaults to `available`; `awaiting_data` leaves a source-state entry without fetching. |
| `/sources/*/repository` | string, required for available feeds | GitHub `owner/repository`. |
| `/sources/*/ref` | nonempty string, required for available feeds | Branch/ref resolved once per repository/ref pair. |
| `/sources/*/path` | safe relative string, required for available feeds | Entry JSON path within the producer revision. |
| `/sources/*/stale_after_hours` | positive number, required for available feeds | Freshness threshold against newest selected observation. |
| `/sources/*/os` | string, optional | Qualification OS fallback when the producer row lacks one; aliases normalize as in [build history](history.md). |
| `/sources/*/forks` | object, required for available performance feeds | Map from producer fork ID to the object below. |
| `/sources/*/include_forks` | nonempty array of unique strings, optional | Selects only listed configured fork IDs before validating/associating their records; absent selects all mapped forks. |
| `/sources/*/forks/*/engine` | string, required | Configured engine ID. |
| `/sources/*/forks/*/channel` | string, required | `stable`, `nightly`, `reference`, or `experimental`. |
| `/sources/*/forks/*/backend` | string, required for performance mapping | Backend identity; current stable mapping is `rocm`. |
| `/sources/*/forks/*/repository` | string, required for performance mapping | Engine package repository; checked against producer `fork_repo` when present. |

An `awaiting_data` entry still requires `id`, `engine`, `adapter` and `channel`;
location fields may be absent. A source's `engine` is an ownership label, not a
request to emit an empty card for that engine in every ROCm version.

## Example

This legacy v1 minimal configuration collects qualification only:

```json
{
  "schema_version": 1,
  "reference_model": null,
  "engines": [{"id": "llamacpp", "label": "llama.cpp", "platforms": ["linux", "windows"]}],
  "sources": [{
    "id": "llamacpp-stable-qualification",
    "engine": "llamacpp",
    "adapter": "qualification-v1",
    "repository": "lemonade-sdk/llama.cpp",
    "ref": "qualification-data",
    "path": "qualification/index.json",
    "channel": "stable",
    "stale_after_hours": 72
  }]
}
```

Configuration values become catalog engine/source metadata and ownership labels.
They do not override a contradictory benchmark repository/backend or establish a
measurement's ROCm version. See [field lineage](mappings.md).

## Unified configuration (schema version 2)

The canonical `sources.json` contains `schema_version: 2`, `reference_model`,
`engines`, `projects`, `sources`, and `views`. Project entries have unique `id`,
`label`, upstream `repository`, `default_branch`, and optionally `forks` (each
with `repository`, `role`, optional `channel`), `ships`, `note`, and
`tag_pattern`. These describe project identity and relationships; they do not
replace the repository on a readiness feed.

Each source has a unique `id`, a `project` ID and a `type`. `readiness` sources
use `qualification-v1` or `lemonade-leaderboard-v1` and the feed fields in the
table above. `upstream` sources use `github-actions-v1` and a `jobs` array;
each project may have at most one. Jobs have `id`, `label`, `category`,
`workflow`, `match` (one of `name`, `prefix`, or `regex`), `target`, `stack`,
`os`, `where`, and `cadence`. See the checked-in configuration for selectors.

`views.readiness.sources` and `views.upstream.sources` explicitly select source
IDs of the corresponding type. The upstream view also defines `window_days`
(1–90) and `client_rule.targets` (gfx IDs), with an optional description.
Unknown, duplicated, dangling, and cross-view IDs are rejected. Omitted or empty
upstream membership disables upstream collection. Unselected sources are still
validated. Existing schema v1 readiness configurations retain their behavior
and do not implicitly enable upstream collection; the internal legacy v1
upstream projects shape is also accepted by the loader for compatibility.

Use `python scripts/collect.py --sources sources.json` for the full collection,
`python scripts/upstream.py --sources sources.json --output-dir data` for an
upstream-only refresh, and `python scripts/conformance.py --data-dir data
--sources sources.json` for conformance against the selected readiness feeds.

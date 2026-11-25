# Attempt status

`data/sync.json` has schema version **1**, with a single `/sync` object.
`scripts/sync.py::publish_sync()` writes collection status;
`scripts/publish.py::publish()` writes the live published status and synthesizes
failure diagnostics when collection output cannot be trusted. The same object
is embedded in the [live pointer](latest.md) and successful [catalog](index.md).

| Pointer | Type / presence | Rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `1` | File format constant. |
| `/sync` | object, required | The four latest-attempt properties below, plus optional `attempts`. |
| `/sync/attempted_at` | UTC timestamp string, required | Attempt time; timezone must represent UTC. |
| `/sync/status` | string, required | `success` or `failed`. |
| `/sync/last_successful_at` | UTC timestamp string or null, required | Equals `attempted_at` on success. On failure, preserve the prior successful time, or null if none. |
| `/sync/errors` | array of diagnostic objects, required | Empty on success; failure details on failure. |
| `/sync/errors/*/source_id` | string, required | Configured source ID, `package-evidence`, or `pipeline`. |
| `/sync/errors/*/record` | string, required | Source record JSON pointer or relevant file/location; may be empty for document-level errors. |
| `/sync/errors/*/field` | string, required | Invalid/missing field or operation such as `fetch`, `tests`, or `publication`. |
| `/sync/errors/*/reason` | string, required | Human-readable validation/access failure. |
| `/sync/attempts` | array, optional | Observed collection attempts retained for the latest attempt's UTC date and preceding 13 dates. |
| `/sync/attempts/*/attempted_at` | UTC timestamp string, required | Actual attempt time, no later than `/sync/attempted_at`. |
| `/sync/attempts/*/status` | string, required | `success` or `failed`, describing this attempt, not the whole date. |
| `/sync/attempts/*/errors` | array, required | Same structured diagnostics as `/sync/errors`; empty on success. |

A diagnostic contains exactly `source_id`, `record`, `field`, and `reason`.
The timestamps and diagnostics are local run metadata, rather than copied
producer measurements.

CI completion and collection outcome are separate. Known source HTTP/network
access failures affecting required inputs produce failed
sync diagnostics and a degraded artifact, but collection exits successfully
after saving that evidence. The publication command likewise succeeds when it
publishes fresh, valid failure metadata from a successful collection job; it
retains the last-good dataset and records the failed attempt for the dashboard.
It does not turn a failed collection into `sync.status: success`.

For release-backed readiness, an inaccessible optional benchmark feed or a leaderboard that fails source validation is marked
`awaiting_data`. When a benchmark run's package evidence is inaccessible, its
unverified observations are omitted and the source records the run, fork, and
diagnostic under `unavailable_benchmarks`. Independent builds and verified
measurements can still publish successfully.

Invalid source data, ambiguous package evidence, failed tests, unexpected tool
errors, diagnostic-write failures, and invalid or stale publication output
still fail CI. Failures during restore or publication also remain fatal.

The publisher merges prior live attempts (including the single latest attempt in
older metadata) with the current attempt before publishing either success or
failure. It removes exact duplicates, preserves same-day failures and successes,
and expires attempts outside the existing 14-date calendar window. Each attempt
contains exactly `attempted_at`, `status`, and `errors`; tooltip prose is not
stored. Missing or invalid collection output produces a new publication failure
without dropping previous live evidence or replacing the last-good dataset.

Calendars show failure evidence only on its recorded UTC date and only in empty
observation cells without a matching assessment. Earlier failures remain visible
after success, labelled as failed attempts rather than a whole-day outage; a
same-date success after all failures is shown as recovery. Producer/run links
continue to be derived from configured sources and validated diagnostic identifiers.
Dates without observed attempts are not backfilled. Older metadata without
`attempts` retains its latest-attempt-only behavior.

## Example

```json
{
  "schema_version": 1,
  "sync": {
    "attempted_at": "2026-10-29T20:00:00Z",
    "status": "failed",
    "last_successful_at": "2026-10-29T19:09:57.455347+00:00",
    "errors": [{
      "source_id": "llamacpp-stable-qualification",
      "record": "/builds/0",
      "field": "qualified",
      "reason": "missing or invalid required value"
    }]
  }
}
```

`main/data/sync.json` and `main/data/latest.json` report every published attempt.
The sync file at the pinned successful data commit and `/sync` in its catalog
remain immutable. A newer live failure does not rewrite either successful
snapshot. Collection failure output in a local artifact may be degraded; the
publisher never replaces the last-good manifest with that output.

## Collection findings

`scripts/findings.py::collection_findings()` turns `/sync/attempts`, the latest
attempt and each source's `last_check` into the `findings` array published in
`index.json` and `latest.json`. The dashboard does not derive explanations from
sync diagnostics; it shows a finding in an empty cell only when every scope
entry of the finding equals the cell's corresponding fields.

| Pointer under `/findings/*` | Type / presence | Rule |
| --- | --- | --- |
| `/id` | string, required | `<kind>:<16 hex>` content hash. |
| `/kind` | string, required | `collection_failed` or `upstream_unchanged`. |
| `/applies_to` | string, required; `missing_observation` | Shown only on cells without an observation. |
| `/scopes` | nonempty array, required | Each entry has a UTC `date` and optional `source_id`. A failed source scopes to itself; a Lemonade benchmark failure scopes to qualification sources of the same engine; pipeline and unknown failures scope to the date only. |
| `/finding` | string, required | Display text, prefixed `No new dashboard data:` when the latest attempt failed and this failure came after the last successful attempt, otherwise `Collection attempt failed:`. Repeated failures with the same reason for one cell are merged. Unrecognized reasons become `<source_id> could not be refreshed.` |
| `/status` | string, optional | Set when a later attempt that date succeeded after the day's last failure. |
| `/evidence` | array, required | `{label, url}` HTTPS links recognized from the diagnostics or check run. |

An `upstream_unchanged` finding is scoped to the source and the UTC date of its
`last_check.checked_at`, with the check run as evidence.

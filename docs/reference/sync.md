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
access failures (including unavailable benchmark job evidence) produce failed
sync diagnostics and a degraded artifact, but collection exits successfully
after saving that evidence. The publication command likewise succeeds when it
publishes fresh, valid failure metadata from a successful collection job; it
retains the last-good dataset and records the failed attempt for the dashboard.
It does not turn a failed collection into `sync.status: success`.

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

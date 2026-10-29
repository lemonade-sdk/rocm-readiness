# Attempt status

`data/sync.json` has schema version **1**, with a single `/sync` object.
`scripts/sync.py::publish_sync()` writes collection status;
`scripts/publish.py::publish()` writes the live published status and synthesizes
failure diagnostics when collection output cannot be trusted. The same object
is embedded in the [live pointer](latest.md) and successful [catalog](index.md).

| Pointer | Type / presence | Rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `1` | File format constant. |
| `/sync` | object, required | Exactly the four properties below. |
| `/sync/attempted_at` | UTC timestamp string, required | Attempt time; timezone must represent UTC. |
| `/sync/status` | string, required | `success` or `failed`. |
| `/sync/last_successful_at` | UTC timestamp string or null, required | Equals `attempted_at` on success. On failure, preserve the prior successful time, or null if none. |
| `/sync/errors` | array of diagnostic objects, required | Empty on success; failure details on failure. |
| `/sync/errors/*/source_id` | string, required | Configured source ID, `package-evidence`, or `pipeline`. |
| `/sync/errors/*/record` | string, required | Source record JSON pointer or relevant file/location; may be empty for document-level errors. |
| `/sync/errors/*/field` | string, required | Invalid/missing field or operation such as `fetch`, `tests`, or `publication`. |
| `/sync/errors/*/reason` | string, required | Human-readable validation/access failure. |

A diagnostic contains exactly `source_id`, `record`, `field`, and `reason`.
The timestamps and diagnostics are local run metadata, rather than copied
producer measurements.

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

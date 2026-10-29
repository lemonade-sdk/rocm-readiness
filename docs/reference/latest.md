# Live dataset pointer

`data/latest.json` is written by `scripts/publish.py::publish()` after staging and
committing a successful dataset, or when publishing failed-attempt status. Its
schema version is **1**. It is not an input to the collector adapters.

| Pointer | Type / presence | Source and rule |
| --- | --- | --- |
| `/schema_version` | integer, required; `1` | Publisher constant. |
| `/data_commit` | lowercase 40-character Git SHA string or null, required | Successful staged dataset commit; preserve the previous value on failure. Null before any successful dataset. |
| `/index_url` | HTTPS string or null, required | `https://raw.githubusercontent.com/<repository>/<data_commit>/data/index.json`; null exactly when the commit is null. |
| `/sync` | object, required | Latest attempt's [sync object](sync.md), identical to live `data/sync.json`'s `/sync`. |

Read the live file from `main`, then read `index_url`. Resolve catalog, overview,
history and performance paths relative to this pinned URL. Do not combine the
live `main/data/index.json` with a previously pinned dataset.

## Example

```json
{
  "schema_version": 1,
  "data_commit": "2d3ce418d22c6f17e35d2de40d112e18cfd77f65",
  "index_url": "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/2d3ce418d22c6f17e35d2de40d112e18cfd77f65/data/index.json",
  "sync": {
    "attempted_at": "2026-10-29T19:09:57.455347+00:00",
    "status": "success",
    "last_successful_at": "2026-10-29T19:09:57.455347+00:00",
    "errors": []
  }
}
```

## Failure behavior

A failure changes the live pointer's `/sync` and live `sync.json`. It leaves
`data_commit`, `index_url`, and all last-good dataset records unchanged. A read
through the preserved `index_url` therefore still returns the successful
catalog and its original successful sync snapshot. The pointer-update commit is
separate from the data commit named by the pointer. See [publication](../data-publication.md#publishing-and-recovery).

# Data publication

The source branch contains code and source configuration. The `dashboard-data`
branch contains finalized dashboard JSON. Git history retains previous datasets;
CI artifacts retain raw copies and diagnostics for 30 days.

## App entry point

After merge and the first trusted main run, load:

```text
https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/dashboard-data/latest.json
```

`latest.json` contains `data_commit`, `index_url`, and the current `sync` status.
Load `index_url`, then resolve overview/history paths relative to that URL.
All files for that view come from the same immutable commit. The app reads
`latest.json` again when refreshing data.

## Each run

1. Restore the dataset identified by the current pointer. A missing data branch
   starts the first collection; access errors fail the run.
2. Collect and validate sources. Previously verified observations retain their
   attribution from the final dataset; new observations require fresh evidence.
3. On success, create a data commit and a pointer commit, then push both together.
   Concurrent changes reject the push. The source branch is unchanged.
4. On failure, retain the good data pointer, update only the latest sync status,
   and exit nonzero. Before the first success, the pointer has no dataset.

Only main-branch runs publish. PRs run the tests and ingestion with read access.
Final data commits exclude raw files, standalone error reports, intermediate
provenance caches, and publication state. Required per-record evidence remains
inside the final model/build records.

## Bootstrap and recovery

Merging the workflow enables the first main run to create `dashboard-data` using
its job token. No cloud account or Pages setup is required for the JSON endpoint.
A repository policy blocking branch writes must be resolved before publication.

Retry the workflow after fixing a failed source or access problem; the good
pointer remains available. For recovery, identify a verified data commit from the
branch history, stop competing publication runs, and review a pointer update to
that commit with its matching `index_url`. Preserve history and the same
expected-head guard. Resume ingestion from that verified dataset.

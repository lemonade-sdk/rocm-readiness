# Data publication

`main` contains the app, source configuration, and finalized JSON under `data/`.
A temporary working branch stages data updates; its changes are squashed into
`main`. Git history retains previous datasets;
CI artifacts retain raw copies and diagnostics for 30 days.

## App entry point

After merge and the first trusted publication run, load:

```text
https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json
```

`latest.json` contains `data_commit`, `index_url`, and the current `sync` status.
Load `index_url`, then resolve overview/history paths relative to that URL.
All files for that view come from the same immutable commit. The app reads
`latest.json` again when refreshing data.

## Each run

1. Restore the dataset identified by `main/data/latest.json`. An existing `main`
   without published data starts the first collection; access errors fail the run.
2. Collect and validate sources. Previously verified observations retain their
   attribution from the final dataset; new observations require fresh evidence.
3. Stage the final JSON on a temporary local `dashboard-data` branch. Squash its
   changes into `main`, then add the pointer commit and push both together. The
   pointer pins the squashed data revision. Source files are preserved. Concurrent
   changes reject the push; the temporary branch is discarded.
4. On failure, retain the good data pointer, update only the latest sync status,
   and exit nonzero. Before the first success, the pointer has no dataset.

Only main-branch runs publish. PRs run the tests and ingestion with read access.
Data-only commits skip collection triggers. Final data commits exclude raw files,
standalone error reports, intermediate
provenance caches, and publication state. Required per-record evidence remains
inside the final model/build records.

## Bootstrap and recovery

Merging the workflow enables the first main run to add `data/` using its job token.
No cloud account or Pages setup is required for the JSON endpoint. A repository
policy blocking direct updates to `main` must be resolved before publication.
The workflow never bypasses branch protections.

Retry the workflow after fixing a failed source or access problem; the good
pointer remains available. For recovery, identify a verified data commit from the
`main` history, stop competing publication runs, and review a pointer update to
that commit with its matching `data/index.json` URL. Preserve history and the same
expected-head guard. Resume ingestion from that verified dataset.

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
The app loads `index_url`, then the overview named by `index.default_version`
(or the user's selected ROCm version). The default is the newest indexed ROCm
version; individual engine builds are selected within that version.

The app loads only the files needed for the current view:

| File | When the app loads it |
| --- | --- |
| `latest.json` | Startup and refresh; supplies the immutable index URL and current sync status |
| `index.json` | After reading the pointer; lists versions, their overview paths, and the default version |
| `rocm/<version>/overview.json` | Selecting a version; supplies engine cards, latest builds, and latest performance summaries |
| `rocm/<version>/history/<month>.json` | Browsing build history for that month |
| `rocm/<version>/performance.json` | Requesting full model measurements or performance history |
| `performance/comparisons.json` | Requesting a backend baseline/comparison; includes Vulkan and HRX records |
| Producer build report (`report_url`) | Opening a build's detailed evidence |

Version-to-version comparison loads the other version's overview. For a Vulkan
baseline, select `backend: "vulkan"` from the comparison data and match model,
workload, quantization, and hardware. HRX results are a separate backend, not the
Vulkan baseline. Neither comparison backend is assigned an artificial ROCm version.

Resolve dataset paths relative to the pinned index URL, so all files for a view
come from the same immutable commit. Refresh by reading `latest.json` again;
do not mix files from different dataset commits.

## Published files and CI artifacts

The published runtime dataset contains only:

```text
data/
├── latest.json
├── index.json
├── sync.json
├── rocm/<version>/
│   ├── overview.json
│   ├── history/<month>.json
│   └── performance.json
└── performance/comparisons.json
```

Performance files exist for versions with measurements. `sync.json` is published
for tooling, but the app already gets current status and errors from
`latest.json.sync`; it does not need a separate status request. The sync metadata
in the pinned dataset describes that dataset's successful collection.

Raw source copies (`raw/`), standalone `errors.json`, intermediate
`provenance/packages.json`, and publication state stay in the Actions artifact,
retained for 30 days. They are not published or fetched by the app, including on
demand. Essential package, release, and cached-registry evidence remains inside
the published measurement records so later ingestions can reuse verified history.

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
inside the final model/build records. ROCm measurements live only in their verified
version's `performance.json`; non-ROCm Vulkan and HRX results live in
`performance/comparisons.json`, referenced by `comparison_performance` with a
`path` and `count`. Publication validates that comparison records make no ROCm or
qualification claims. Missing ROCm evidence prevents successful collection and
keeps the last good dataset pointer.

Restoration accepts previous schema-2 datasets with the legacy
`unassigned_performance` manifest and `performance/unassigned.json`. This is a
migration compatibility path: new collections never write that manifest or file,
and old measurements are rebuilt from current sources with verified evidence.
`check.py` ignores previous data until the published index has
`attribution_version: 2`; subsequent runs resume historical carry-forward.
The migration PR removes the tracked generated dataset; the first successful
main-branch run replaces it completely. Git history retains the old dataset.

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

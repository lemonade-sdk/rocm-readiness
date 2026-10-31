# Upstream health

Upstream health shows observed GitHub Actions results for explicitly configured jobs in each project's repository. It shares the published immutable dataset and pointer with ROCm readiness, but opens independently of any ROCm version overview.

## Configuration and scope

[sources.json](../sources.json) schema 2 defines project identities and forks, typed sources, and explicit readiness and upstream view membership. An upstream source uses `github-actions-v1` and names job selectors and configured target, stack, OS, category and cadence. The upstream view supplies `window_days` and `client_rule.targets`. See the [source reference](reference/sources.md) for the contract and legacy behavior. The `ships` text is manually configured distribution information, not proof of a release or artifact.

The badge describes observed runs of configured test jobs: a target in `client_rule.targets`, another configured client target, or no configured test observed. It does not prove the machine's physical hardware, comprehensive project support, or published artifacts. No configured jobs and incomplete collection have unknown coverage. The configured hardware and selectors need [independent review](https://github.com/lemonade-sdk/rocm-readiness/issues/55); [artifact evidence](https://github.com/lemonade-sdk/rocm-readiness/issues/49) is separate work.

Each retained default-branch job records its own result, first failing step, queue wait and links. Pull request verdicts use checks on the final head commit completed by merge time; later reruns do not establish the earlier result. Missing or insufficient historical evidence is unknown. A job with no steps is skipped if its condition skipped it, otherwise recorded as requested but not run. Default-branch runs and configured release tags are included; pull request runs and PyTorch `ciflow` tag pushes are excluded.

On a project page the lens filters job-derived KPIs, charts, merge gate and failed steps. Badge, platform table and findings are project-wide. Platform columns reflect configured jobs and observed results; distribution is manual text. Green bars count passes only. A partial-collection notice indicates backfill; a collection error is shown separately.

## Collection and publication

The upstream budget caps upstream HTTP attempts, including failed attempts, across projects. Readiness collection makes additional calls, so the upstream cap alone does not guarantee a total hourly API limit. The default cap is 800; CI uses 100 for pull requests and 800 otherwise. Projects share the budget, newest first. Budget exhaustion yields partial coverage; API failures are recorded in `coverage.error`. Readiness publication remains independent of upstream collection failures.

Previous monthly files retain completed scan IDs and job records. `coverage.cache_identity` binds reuse to relevant source/job configuration; incompatible or legacy cache is recollected. `coverage.pending` checkpoints paginated enrichment so subsequent collections can advance. Each run must still have enough budget to read the relevant project run listings; repeated runs are not guaranteed to converge under an arbitrarily small budget. [Issue 56](https://github.com/lemonade-sdk/rocm-readiness/issues/56) tracks the listing pagination floor. `coverage.complete`, `since`, `listed_since`, `collected_at`, and `oldest_run_at` describe collection progress. Reused evidence is bounded by the current window.

`index.json` references `upstream/overview.json`, containing project aggregates, coverage and monthly file references. `upstream/<project>/ci/YYYY-MM.json` holds retained executions and scan state. Conformance validates file references and retained records, and reconciles monthly daily-state counts and pass/decided totals with the overview; it does not validate badges, platforms, not-running counts or merged-red totals. Publication pins the whole dataset to one commit.

## Local preview

```sh
GH_TOKEN=<token> uv run --no-project --python 3.12 python scripts/check.py \
  --output-dir data/local-preview --previous-data data
GH_TOKEN=<token> uv run --no-project --python 3.12 python scripts/upstream.py \
  --sources sources.json --output-dir data/local-preview --seed-from data --budget 800
cd ui
npm run dev:local
```

The second command refreshes upstream alone. `dev:local` is a development-only preview of `../data/local-preview`, or `LOCAL_DATA_DIR` if set; it does not change the published pointer. Add a project and its typed source to `sources.json`, explicitly select it in `views.upstream.sources`, and run the unit and local collection checks. Job `match` accepts exactly one of `name`, `prefix`, or `regex`; GitHub truncates job names at 100 characters.

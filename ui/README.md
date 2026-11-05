# Dashboard UI

Requires Node.js 24 and npm. From this directory:

```sh
nvm install
nvm use
npm ci
npm run dev
```

Open the Local URL printed by Vite. The browser reads the public
`main/data/latest.json` pointer and follows its pinned dataset revision. No data
server, credentials or local collection is required.

## Local dataset preview

To inspect a dataset you collected locally, before it is published:

```sh
npm run dev:local
```

This serves `../data/local-preview` (set `LOCAL_DATA_DIR` to change it) at
`/local-data/` and reads its `index.json` instead of the published pointer.
Create the directory with `scripts/check.py --output-dir data/local-preview` or
refresh only the upstream view with `scripts/upstream.py`. See
[Upstream health](../docs/upstream-health.md).

## Upstream health

The header switches between **ROCm readiness** and **Upstream health**
(`?track=upstream`). Upstream health shows one card per project with its
computed badge, forks and 14-day status strips. A project page
(`&project=<id>`) has a filter (`&lens=<stack or gfx target>`) that filters job-derived numbers and charts. The badge, platform table and findings remain project-wide. Configured targets and distribution do not verify physical hardware or published artifacts. It also shows:

- per-day diverging bars (passes up, failures down);
- day panels linking each run's job log, commit and pull request;
- platform coverage;
- the merge gate;
- what is failing on main;
- per-job status ticks for the whole window.

## Appearance

The [dashboard design language](../docs/ui-design-reference.md) defines the
palette and interaction guidance for both views.

The dashboard follows the device's light/dark preference by default, including
changes while it is open. Use the sun/moon control in the header to choose
**System**, **Light**, or **Dark**. Explicit choices are saved in this browser;
choosing System restores automatic behavior. Theme selection is applied before
the app renders. If browser storage is unavailable, switching still works for
the current visit.

The collector discovers the newest stable ROCm track from current stable
qualification records (`views.readiness.stable_anchor: "latest"`). It selects
at most the next two numerically newer nightly tracks with real qualification
records (`nightly_limit: 2`). AMD SDK availability alone does not establish a
qualified llama.cpp archive. Full dated nightly SDK identifiers remain in each
build's provenance; numeric SDK version identifiers remain unchanged for package mapping.

Every collection rebuilds readiness from current producer snapshots, without
carrying forward previous downstream records. Records present in those producer
snapshots remain available within the selected tracks. The catalog is ordered
numerically ascending, with stable first. The UI renders that catalog and uses
`index.readiness.stable_anchor` to label stable. Older datasets without scope
metadata retain an explicit legacy-scope notice.

Page One nests engines and recorded channels under each version. There is no
Page One version selector. One shared legend describes qualification marks; missing
dates remain neutral gaps. Build timelines cover the last 14 UTC calendar dates.

Page One shows build qualification only. Benchmark execution inventories remain in
the collected dataset, separate from qualification; the overview neither fetches nor
renders their statuses, counts or attempt inspector. They do not alter qualification
marks. Producer reports, build/source/OS identities and the 14-day window remain.
Calendar headings group day numbers under spanning month names with a month boundary.
Build links use the shared custom tooltip with formatted UTC report time, qualification,
channel, revision and build identity. The repeated ROCm/channel heading is omitted
inside a single-channel card; multiple channels retain concise channel headings.
Mobile keeps the horizontally scrollable timeline; a vertical redesign is deferred.

Detail views select only tracks in the supplied catalog and retain inline qualification evidence and
model-performance details. URLs retain
the selected version, view, platform, model, hardware, workload and detail context.
Internal navigation keeps the active dataset revision; reloading reads the latest
published pointer.

Build history supports platform and package/build searches. Opening a build loads
its pinned producer report on demand and displays individual checks, tiers,
durations, warning/failure reasons and audit details. Report failures retain the
build metadata and offer retry.

Performance views show measured package tags, dates, hardware, workloads and
metric units. Cross-version comparisons require complete compatible hardware,
model, quantization and workload settings. Missing metadata remains unmatched.
Package qualification requires exactly one matching retained build record.

The overview reads all referenced monthly history files at one pinned revision.
Only engines and channels with recorded builds render. Expected OS rows come
from JSON metadata within populated groups. Each tile has a 14-day UTC calendar
ending today, with one selectable mark per build. Multiple same-day builds stay
distinct. Explicit producer qualification determines pass/fail; missing verdicts
are neutral evidence links, and dates without builds say “No data” without an
outcome mark. Links open
exact-build details with OS/source context. Today's date is highlighted in the
calendar header. Dates are grouped internally in UTC. Qualification does not
establish actual artifact publication. Page 1
has no test counts or compiled-target panels; those remain in build details.

Datasets can also retain benchmark execution attempts and summaries in
`rocm/<version>/executions.json`, including failed attempts without throughput
measurements. The overview timeline currently displays build qualification only;
it does not turn benchmark execution outcomes into qualification marks.

Reloading the page reads the live pointer again. Readiness retry controls
replace an existing active dataset only after its requested version loads successfully;
a failed retry retains the last usable session.
Ingestion status and browser-read errors are displayed separately. Timestamps
are shown in UTC. External JSON evidence opens in a separate tab.

## Checks

```sh
npm test
npm run build
npx playwright install chromium webkit
npm run test:browser
```

Unit/component checks validate JSON boundaries, revision isolation, URL scope,
refresh recovery and request races. Browser checks run against controlled fixtures
in Chromium, WebKit and a mobile WebKit viewport, including browser history and
keyboard navigation. Fixture checks do not verify producer availability.

For a local production build preview:

```sh
npm run build
npm run preview
```

The build emits static assets into `dist/`. Serve the application at its static
root; navigation uses query strings and requires no path rewrite rules. The UI
checks workflow builds and tests these assets independently of data ingestion.

The published dashboard uses GitHub Pages at `/rocm-readiness/`. See
[dashboard hosting](../docs/ui-hosting.md) for the release workflow, verification,
retry and rollback instructions. To preview that production path locally:

```sh
VITE_BASE_PATH=/rocm-readiness/ npm run build
VITE_BASE_PATH=/rocm-readiness/ npm run preview
```

Open `/rocm-readiness/` on the preview server. The default local development path
remains `/`.

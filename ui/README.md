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
computed badge and aligned summary metrics in flat project sections. Project
headings link to CI Activity, where source repositories, forks and collection
notices are shown.
Nested sidebar links switch between Overview (`&view=overview`) and CI Activity
(`&view=ci`). Overview shows one project per row with a 14-day activity calendar. Selecting a
day opens its UTC date and category in CI Activity, including after reload.
CI Activity summary tiles and project status labels use a normal cursor and passive hover tooltips; clicking does not activate or pin them. Keyboard focus also exposes their descriptions.
CI Activity uses the shared Project, Platform, Stack and Target filter controls
and contains daily run counts and detailed evidence. Project headings use the primary text color. A project
activity page (`&view=ci&project=<id>`, with legacy `&project=<id>` URLs supported) uses independent inclusive stack (`&stack=<comma-separated values>`) and target
(`&target=<comma-separated values>`) filters for job-derived numbers and calendars.
Omitting a group includes all its values; legacy `&lens=<stack or target>` links still work. The badge, platform table and findings remain project-wide. Configured targets and distribution do not verify physical hardware or published artifacts. It also shows:

- a detailed daily table with grouped month headings, stacked outcome bars on one shared run-count scale;
- interactive day tooltips with totals, exact outcome counts and each run's job log, commit and pull request;
- platform coverage;
- the merge gate;
- failing steps on main;
- an always-visible CI jobs table with job names, platform icons and 14 days of outcome cells. Job-name tooltips show stack, target and the 14-day pass rate. Each cell opens that job’s run evidence.

## Appearance

All dashboard UI changes follow [Signal Deck](../docs/ui-design-reference.md), with
ROCm documentation blues, a side rail for dashboard navigation and dataset
provenance, and tables with distinct symbols for qualification and CI outcomes.

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
the collected dataset, separate from qualification; the overview does not render
execution-attempt statuses or an attempt inspector. Its popups load pinned performance
data and show measurements matched to each package. Measurements do not alter qualification marks. Producer reports, build/source/OS identities and the 14-day window remain.
Calendar headings group day numbers under spanning month names with a month boundary.
Build links open an interactive popup titled with the UTC date and platform (for example, “November 8, 2026 · Linux”). The compact label-left/value-right summary shows the latest build’s qualification, build-job result, publication status and human-readable produced timestamp, plus the daily package count and matched benchmark measurement count. It does not enumerate nightly GPU families. Unreported results, loading and unavailable measurements remain explicit. One View qualification details link opens the full date/platform group without selecting a single build. The repeated ROCm/channel heading is omitted
inside a single-channel card; multiple channels retain concise channel headings.
At 540 CSS pixels and below, overview calendars use date rows with platform
columns, and qualification trends use horizontal bars down a dated list. Wider
layouts retain the horizontally scrollable timelines.

Phones (up to 640 CSS pixels) show Performance measurements and qualification
packages as separated records with expandable evidence. Package qualification
shows ROCm once, prominent stable-build or nightly GPU-family headings, and check
legends beneath each build/family group. The compact header keeps
the current view title and a filter icon visible; filters and measurement sorting
expand in place. At 540 CSS pixels and below, CI Activity uses expandable date cards with category selection and run evidence inside
each card. Project metrics use square tiles in a responsive four/two-column grid. Qualification date rows expand their packages in place. CI jobs open individual dated outcome tables. Wider CI matrices retain horizontal scrolling,
with selected evidence expanded below the matrix. Below 1280 CSS pixels, the Navigation button reveals
workspace navigation above the content, regardless of orientation. Tables remain
above the independent 640 CSS-pixel phone breakpoint; wider layouts retain the sidebar.

Detail views select only tracks in the supplied catalog and retain inline qualification evidence and
model-performance details. URLs retain
the selected version, view, platform, model, hardware, workload and detail context.
Internal navigation keeps the active dataset revision; reloading reads the latest
published pointer.

Date-only tooltip labels use a full month, day and year, without a UTC suffix. Produced timestamps include a human-readable date, time and UTC. Published ZIP and tar.gz archive names in package evidence link directly to their release assets. A shared “Data source” row with a “View data source” link appears beside Date and Workflow run. Each platform has its own “Qualification record” row with a “View record source” link. If package sources differ, their source links stay within the owning package.
Package tooltips place the qualification tag beside the operating system; dataset revision and ROCm SDK are omitted from this summary, while upstream SHA remains linked.

Build history supports platform and package/build searches. Opening a build loads
its pinned producer report on demand and displays individual checks, tiers,
durations, warning/failure reasons and audit details. Highlighted evidence labels
and values come from the downstream collector’s `report_snapshot` and its
`display_evidence` entries;
the UI does not infer GPU execution from audit fields. Reports without these
entries keep their raw audit details. See the [collected report contract](../docs/reference/history.md#collected-report-snapshots).
Report failures retain the
build metadata and offer retry.

Performance uses the shared visible filter buttons for ROCm version, measurement
platform, hardware system, and workload. Each choice shows its selected state;
there are no separate All buttons. Model selection
remains a compact dropdown in the same filter bar; selections remain in the URL.
Measurements use one table for both landing and legacy model URLs, with TPS, peak
VRAM, TTFT, OS, and context. Quantization remains in evidence popups. Model-name popups retain package/run
provenance and qualification evidence. Workload labels display 4K/32K while the
source scenario and numeric context metadata remain unchanged. Workload details
remain in evidence popups; timestamps use UTC.

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

Performance defaults to the latest observation per build, source, engine/fork/channel, model,
quantization, workload/input, OS, and recorded hardware/context configuration. Older observations within the same build/configuration are collapsed. Rows are grouped under build tags, with nightly GPU-family subgroups from
matched qualification packages or their attributed package filenames. Quantization
remains available in evidence popups. P95 is copied from the producer TPS statistic; no cross-build averaging is
performed. Legacy history URL flags no longer alter the table.

Build Qualification and Performance share Find build and Reset filters controls
in the filter toolbar. Reset clears each view’s selected package/model/day and
filter scope while keeping the ROCm version (and qualification date window).
Performance model-name links open all workloads for that model/package; metric
bars retain exact-observation links and highlight their recorded workload.

Package qualification performance previews show Prefill TPS and Decode TPS in tokens per second, with higher values better; TTFT is omitted from that preview.

Performance measurement popups use a compact 35rem viewport-constrained surface at 1024 CSS pixels and above, anchored above or below the model to avoid a narrow side column. Below 1024 CSS pixels the popup remains narrower; phone evidence keeps its inline layout.

Performance headers keep units in shared definition tooltips. Context means the
configured token window capacity. Header arrows sort rows inside each build/GPU
family; missing metrics stay last. Build order can follow the selected metric
only when all visible rows have the same complete compatible cohort identity.
Sorting and build order persist in the URL. Both views expose removable Build/Date
scope buttons in the filters. Hardware choices use CPU/GPU names when recorded,
with the full source identifier available on hover.

All project views share the outcome registry, glyph component and legend component
used by Build Qualification. CI jobs show any recorded failure as Fail, distinguish
skipped/requested/pending/missing evidence, and include their own legend. See the
shared outcome conventions in `docs/ui-design-reference.md` before adding tables.

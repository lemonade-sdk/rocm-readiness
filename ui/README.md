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

## Appearance

The dashboard follows the device's light/dark preference by default, including
changes while it is open. Use the sun/moon control in the header to choose
**System**, **Light**, or **Dark**. Explicit choices are saved in this browser;
choosing System restores automatic behavior. Theme selection is applied before
the app renders. If browser storage is unavailable, switching still works for
the current visit.

The dashboard provides version selection, readiness summaries, retained build
history, inline qualification evidence and model-performance details. URLs retain
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

The overview reads all referenced monthly history files at the selected dataset
revision to show qualified builds out of retained builds, with a separate outcome
breakdown. Latest-package check bars use published counters; skipped and missing
checks remain in the total. Partial check breakdowns retain their known counts
without inventing absent categories. Platform cards also show compiled GPU-target
coverage and the package's ROCm version.

Reloading the page reads the live pointer again. Error-specific retry controls
replace the active dataset only after its requested version loads successfully;
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

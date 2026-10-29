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

The shell provides version selection, overview, latest-build evidence links and
access to pinned monthly history and model-measurement JSON. URLs retain the
selected version, view, platform and detail context. Other query parameters are
preserved during navigation.

The overview reads all referenced monthly history files at the selected dataset
revision to show qualified builds out of retained builds, with a separate outcome
breakdown. Latest-package check bars use published counters; skipped and missing
checks remain in the total. Partial check breakdowns retain their known counts
without inventing absent categories. Platform cards also show compiled GPU-target
coverage and the package's ROCm version.

Refresh reads the live pointer again and swaps datasets after the requested
version loads successfully. A failed refresh retains the last usable session.
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

# Page One stable engine overview implementation plan

**Goal:** Implement the agreed stable-only portion of UI v2 Page One, using issue #38 as the approved scope.

**Architecture:** Extract a focused engine overview from App. Keep dataset loading and errors in App, producer qualification per platform, and navigation scoped by version, engine, source and build. Integrate Tailwind incrementally without its reset. Detailed execution ingestion/UI (#43/#44), prior-build comparisons (#37), nightly and vLLM remain separate dependencies.

**Tech stack:** Existing React, TypeScript, Vite, React Router; Tailwind Vite plugin.

- [x] Add regressions for no executive OS filter, both supported platform results, absent evidence omission and scoped Page Two build links.
- [x] Extract engine cards, remove historical page-wide metrics and omit unsupported fields; retain genuine history loading errors/retry.
- [x] Add exact Page Two build/source scope without replacing its general build browser.
- [x] Integrate Tailwind without Preflight; preserve theme CSS and responsive cards.
- [x] Run unit/build/browser checks, inspect desktop/mobile preview, review diff and document deferred issue portions.

Models passing remains retained in the product scope but is not fabricated from leaderboard counts. Its verified implementation follows ingestion #43 and UI #44. Qualification missing/skip counts are real producer outcomes, distinct from absent source fields.

Verification: 69 unit tests, 27 browser tests (Chromium, WebKit, mobile), production build, desktop/mobile live-dataset screenshots, no mobile overflow. Independent diff review found no blocking defect. This delivers only the stable layout portion of #38; held work remains open.

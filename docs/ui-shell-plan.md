# MVP1 UI shell implementation plan

**Goal:** Deliver issue #14 as a locally previewable typed browser shell.
**Spec:** [Approved design](ui-shell-design.md).
**Architecture:** React + TypeScript + Vite in `ui/`, React Router URL state,
runtime-validated static JSON, atomic immutable dataset sessions.
**Execution:** Inline implementation with a final independent review. The user
approved proceeding; preserve that authorization through routine implementation.

## Constraints

- Stable llama.cpp only; preserve ingestion and publication behavior.
- Keep all session reads pinned to one immutable dataset revision.
- Keep the last usable session when refresh fails; distinguish browser and sync errors.
- Preserve the mockup's visual hierarchy without importing its embedded dataset.
- Local review first; no publishing, merging or GitHub comments.

## Review focus

Malformed paths must not escape the selected revision; unknown URL versions must
not silently change scope; late requests must not overwrite newer selections;
empty datasets must remain usable; failed refresh must retain visible data and
the newest known ingestion status. Cover these in loader and browser tests.

## Task 1: Dataset session

Files: `ui/package.json`, configs, `ui/src/data.ts`, `ui/src/data.test.ts`.
Interface: `loadSession(version?, fetcher?, signal?)` returns validated pointer,
index, selected version and overview; `loadVersion(session, version, ...)` reads
only through the session's immutable index URL.

- [x] Write failing tests for pinned reads, malformed data, path escapes, empty
  datasets, invalid selections and unsuccessful reads.
- [x] Implement types, validation and loader; run tests to green.

## Task 2: Browser shell

Files: `ui/src/App.tsx`, `ui/src/styles.css`, `ui/src/main.tsx`,
`ui/src/App.test.tsx`, `ui/index.html`, `docs/ui-design-reference.md`.
Interface: URL query state owns ROCm version, view, filters and selected detail;
React owns the active session, loading/error states and refresh transaction.

- [x] Write failing rendering tests for default selection, retry, stale usable
  sessions and version-switch races.
- [x] Build responsive header, overview/engine navigation, dataset status and
  version loading. Clearly bound the detailed views to their later work units.
- [x] Verify tests and TypeScript/static production build.

## Task 3: Browser checks and local handoff

Files: `ui/e2e/shell.spec.ts`, `ui/playwright.config.ts`,
`.github/workflows/ui.yml`, `ui/README.md`, root `README.md`.

- [x] Add controlled browser fixtures for failure, malformed/empty data,
  navigation/history, revision isolation and mobile keyboard-accessible controls.
- [x] Run UI tests, browser checks, production build and the existing Python suite.
- [x] Open the local preview against live published data, inspect its desktop and
  narrow layouts, and record app/dataset revision and verification limitations.
- [x] Obtain a fresh whole-change review; address material findings and rerun checks.

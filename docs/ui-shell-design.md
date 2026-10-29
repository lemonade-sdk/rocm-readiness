# MVP1 browser shell

## Intent

Implement issue #14: a locally previewable browser shell for stable llama.cpp
readiness. Readers select a ROCm version, navigate within that version, and see
whether the published dataset is current and usable. Issue #20 and its referenced
mockup govern the visual baseline; current issue criteria govern data behavior.

## Approach

Use React, TypeScript, Vite and React Router in a separate `ui/` directory.
This is the implementer's recommendation, following the user's delegation of
the stack choice. React provides reusable view components, TypeScript makes the
dataset and navigation contracts explicit, and Vite supplies local preview and a
static production build. Use plain CSS to preserve the existing mockup's styling.

Buildless JavaScript would reduce initial setup, but requires more manual
coordination as the overview, build history and model views grow. A server-rendered
framework adds a runtime the existing static publication contract does not need.

## Scope

- Preserve the refined mockup's header, version selector, visual hierarchy and
  overview-to-engine-to-detail navigation. Keep a compact design reference in the
  implementation without copying the mockup's historical dataset or bundled code.
- Build the shell and real version-loading flow first. Detailed readiness, build
  evidence and performance features remain the subsequent #15–17 work units.
- Select the dataset's default version on first load. Preserve version, view,
  filters and selected detail in URLs and browser back/forward navigation.
- Support keyboard navigation and narrow and wide layouts using semantic controls.
- Preserve the Python pipeline, existing collection commands and source selection.
  Do not publish or deploy during this local-preview stage.

## Dataset boundary

Fetch live `main/data/latest.json`, validate its structure, then fetch its immutable
`index_url`. Resolve every overview, history and performance path against that same
index revision. TypeScript types are supplemented by runtime validation of consumed
JSON fields. Missing evidence must never become a successful qualification verdict.

Build a new dataset session separately during refresh and replace the active
session only after its required reads succeed. Guard against out-of-order requests
when switching versions or refreshing. Keep the last usable session visible when
a refresh fails; show an actionable error and retry control. An ingestion failure
in the live pointer is distinct from a browser fetch failure and from the original
successful snapshot's metadata. Display the latest attempt and last successful
data time with those distinctions intact.

Handle missing or malformed pointers/indexes, unavailable overviews, empty version
lists, invalid URL selections, loading and retry explicitly. Defer full producer
report fetching until the #11 field/loading decision is reviewed; preserve pinned
evidence links and identities in the loader contract.

## Implementation boundaries

Keep dataset types, runtime validation and loading separate from route state and
React rendering. Load deeper history/performance data only when its view needs it.
Use React Router for URL scope and Vitest plus React Testing Library for regression
checks; use Playwright for the key browser journeys. Add further UI/chart libraries
when a real view needs them rather than preselecting them for the shell.

## Verification and local review

Provide documented development, test, build and production-preview commands in
`ui/`. Add a separate UI CI workflow while preserving ingestion CI. Tests must
demonstrate immutable revision isolation, failed refresh retaining usable data,
version-switch races, malformed/empty data, retry and URL restoration. Browser
checks cover the published dataset, controlled failure fixtures, keyboard use and
mobile/desktop layouts. Record app and dataset revisions and distinguish live
observations from fixture checks. Keep the local preview available for user review.

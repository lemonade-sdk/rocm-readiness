# Dashboard hosting

The dashboard is published with GitHub Pages at
[lemonade-sdk.github.io/rocm-readiness](https://lemonade-sdk.github.io/rocm-readiness/).
The [Publish dashboard workflow](../.github/workflows/pages.yml) builds the React
application in `ui/` and deploys its `dist/` artifact. Built files are not committed
to a publication branch.

## Release

Repository **Settings → Pages → Build and deployment → Source** must be
**GitHub Actions**. The workflow deploys through the `github-pages` environment
using the run's short-lived GitHub token and OIDC identity; it requires no stored
deployment credentials.

PRs affecting the UI or Pages workflow run unit checks, a TypeScript/Vite build,
and production-build browser checks at `/rocm-readiness/`. Browser fixtures cover
Chromium, WebKit and a mobile WebKit viewport. PR runs upload build and browser
artifacts without deploying. A reviewed merge to `main` runs the same checks,
then publishes the resulting Pages artifact. The deployment job's environment
link identifies the released site.

The app's asset base and router base use `/rocm-readiness/`. View and filter state
uses query parameters, so shared overview, engine, build and model links work
without server rewrite rules. The UI has no server-side secrets or API process.

Data publication is independent. The browser reads the live
[`data/latest.json` pointer](https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json)
and uses its immutable dataset revision for overview, history and performance.
Data-only commits do not rebuild the app. Reloading the page reads the current
pointer; ordinary internal navigation retains the active revision.

## Verify a release

Open the deployed site, select a ROCm version, and navigate from overview to
build history, qualification evidence and model performance. Reload a shared
detail URL and use browser back/forward. Compare counts, package tags and metrics
with the dataset linked in the footer. Producer reports must load from their
pinned source revision.

Read [`release.json`](https://lemonade-sdk.github.io/rocm-readiness/release.json)
for the deployed `app_commit` and `workflow_run_url` recorded in the built
artifact. Record that app revision, footer dataset commit, browser
targets and observed results. Controlled fixture checks establish failure and
partial-data behavior; they do not establish live producer availability. A green
build alone does not establish that the deployed origin loads the app and JSON.

## Retry and rollback

For a failed build, inspect the failing step and its `pages-browser-results`
artifact. Correct the change through a PR, then merge it. For a transient Pages
deployment failure, rerun the failed workflow or use **Actions → Publish
dashboard → Run workflow**, selecting `main`. Manual dispatch runs even when no
UI file changed. Only `main` deploys.

To roll back an app change, revert its PR on `main` through the normal reviewed
PR process. The resulting UI/workflow change rebuilds and deploys the prior
behavior. A manual dispatch can redeploy the current `main` version. App rollback
does not rewrite the published dataset or its pointer; see
[data publication](data-publication.md#publishing-and-recovery) for data recovery.

If the deploy job reports a Pages configuration or environment permission error,
check the repository's Pages source and the `github-pages` environment's branch
and approval rules. Keep build failures separate from deploy/provider failures
when diagnosing a release.

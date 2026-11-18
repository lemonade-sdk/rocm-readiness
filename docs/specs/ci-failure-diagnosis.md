# Blueprint: Evidence-backed CI failure and skip diagnosis

**Source:** [#98](https://github.com/lemonade-sdk/rocm-readiness/issues/98), from discussion on 2026-11-18; extends [#91](https://github.com/lemonade-sdk/rocm-readiness/issues/91) and [#88](https://github.com/lemonade-sdk/rocm-readiness/issues/88).
**Status:** Draft; planning only, not authorized deployment.
**Author:** Repository maintainers + Copilot

## Problem Statement

Current notifications identify failed steps or unexplained skips but cannot explain
the underlying failure from job logs. Add evidence-backed diagnosis to existing
investigations, keeping confirmed facts distinct from model-generated hypotheses.
Alerts and dashboard publication must continue even when diagnosis is unavailable.

## Scope

### In Scope

- Inspect the exact upstream/downstream run, attempt, workflow revision, job logs,
  and existing qualification reports for actionable incidents.
- Resolve explicit errors and verified prerequisite skips before invoking a model.
- Use a locally served Lemonade model for a bounded, evidence-citing explanation.
- Enrich the same issue and existing Finding row; preserve source verdicts,
  notification identity, labels, mentions, and healthy tooltips.

### Out of Scope

- Automatic fixes, workflow reruns, code execution suggested by logs/models,
  autonomous coding agents, or changes to producer workflows.
- Hosted-model fallback, private-repository logs, direct email, collector
  watchdogs, new dashboard panels, and extra recipient mentions.
- Claiming hidden historical variables or runner availability can be reconstructed
  from a skipped conclusion alone.

## Current State

- The upstream collector records `failed_step` from the first failed step. <!-- from: scripts/upstream.py -->
- Run correlation includes `job_id` in collected records. <!-- from: scripts/upstream.py -->
- Rerun correlation includes `attempt` in collected records. <!-- from: scripts/upstream.py -->
- Downstream report collection attaches `report_snapshot` to build rows. <!-- from: scripts/qualification_reports.py -->
- The evaluator consumes optional `verified_dependencies` metadata for causal skips. <!-- from: scripts/assessments.py -->
- The evaluator consumes optional `verified_skip` metadata for permitted conditions. <!-- from: scripts/assessments.py -->
- Its returned records include `observation_id` for occurrence/correction inputs. <!-- from: scripts/assessments.py -->
- The GitHub adapter supports `has_initial_routing` reconciliation. <!-- from: scripts/notification_channels.py -->
- The dispatcher persists `baseline` policy before deciding whether to notify. <!-- from: scripts/notifications.py -->
- The workflow requires the rollout variable `ROCM_READINESS_NOTIFICATIONS_ENABLED`. <!-- from: .github/workflows/notifications.yml -->
- The current notification job uses `runs-on: ubuntu-latest`. <!-- from: .github/workflows/notifications.yml -->

### Existing jobs inspected

| Existing component | Verified finding |
| --- | --- |
| Lemonade Repo Manager workflow/action [S1, S2] | Uses a self-hosted Strix Halo runner and delegates model/server setup to lemonade-testing. |
| Central runner recipe [S3, S4] | Pins **Lemonade 11.9.0** and **Qwen3.6-35B-A3B-MTP-GGUF**, starts a loopback-only server on a job-specific port, and retains a model cache. |
| Completed Repo Manager run [S5] | Job succeeded; logs show that exact model pulled successfully and selected through Lemonade. This proves an existing deployment pattern, not diagnosis accuracy. |
| Nightly backend benchmark [S6] | Already starts Lemonade for inference benchmarks; it does not diagnose CI failures. |
| llama.cpp ROCm nightly alert [S7] | Lists failed jobs and release status; no model analysis. Do not copy its repeated-mention or assignment policy. |
| Repo Manager release commands [S8] | Cover reviews, releases, and triage; no dedicated failure-diagnosis command is documented. |

## Drift Guard

Run the installed implementation-blueprint skill's guard from the repository root:

```sh
bash "${BLUEPRINT_SKILL_DIR:?}/scripts/check-spec-drift.sh" docs/specs/ci-failure-diagnosis.md
```

Set that variable to the installed skill directory. Local provenance markers
are executable checks; external research is pinned to immutable source revisions.
Add a maintained CI drift check when implementing the feature, not a dependency
on one developer's local skill installation.

## Design Decisions

| Decision | Chosen approach | Alternative considered | Rationale |
| --- | --- | --- | --- |
| Initial model | Qwen3.6-35B-A3B-MTP-GGUF through Lemonade 11.9.0, pinned for the pilot | New model or hosted Claude review action | Reuse the demonstrated local deployment; qualify accuracy before enabling it. |
| Invocation | One tool-free chat-completion request; validate JSON locally | Full Repo Manager/Pi agent | Reading hostile logs does not require shell, browsing, or write tools. |
| Timing | Notify first; enrich asynchronously in the same post-collection workflow | Wait for model analysis before opening an issue | Model availability must not delay operational reporting. |
| Truth | Deterministic evidence may be verified; model output is likely/unknown | Treat model confidence as proof | Plausible explanations are not observed causes. |
| Storage | Bounded public-safe diagnosis record linked to the existing incident | Publish whole raw logs or another dashboard | Preserve privacy, deduplication, and the agreed compact interface. |

**ASSUMPTION:** An equivalent authorized Strix Halo runner can be assigned to this
repository. Existing runner labels are evidence of another repository's setup,
not permission to use its machines. No hardware reservation or inference was run.
Reuse that existing pool and serving pattern before considering new provisioning.
The repository-runner visibility check on 2026-11-18 returned HTTP 403 for the
current token; an administrator must confirm runner-group access and ownership.
That permission failure does not establish that eligible runners are absent.

**ASSUMPTION:** Start with the demonstrated model/server pins above; model
suitability, latency, memory, and context limits remain pilot acceptance gates.
Changing pins later requires rerunning the same evaluation fixtures.

**ASSUMPTION:** Only allowlisted public producer repositories are eligible.
No logs are sent to an external model provider; private evidence needs a
separately approved design.

## Components Affected

- **Evidence/diagnosis module:** Add one focused module and tests under the existing
  scripts/tests structure. Fetch bounded evidence, resolve deterministic cases,
  call Lemonade when necessary, and validate/cache results.
- **Evaluator and run provenance:** Preserve exact run/attempt/job/revision
  references in the incident evidence. Carry diagnosis as optional enrichment,
  not a replacement qualification or anomaly rule.
- **Notification workflow:** Keep collection and GitHub notification on their
  current path. Add optional read-only self-hosted diagnosis and trusted
  publication steps; isolate the model job from issue-write credentials.
- **Publication and issue rendering:** Validate/allowlist the new diagnosis
  fields, update the existing machine-marked investigation without rementioning
  recipients, and reject results for an obsolete observation.
- **Tooltip:** Reuse the single Finding row. Show a short verified cause or
  explicitly prefixed likely cause, with the same investigation/evidence links.

## Implementation Phases

### Phase 1: Collect and verify bounded evidence

**Depends on:** None.

**Changes:**
- Fetch run-attempt job metadata and the workflow at its recorded revision;
  prefer existing pinned qualification reports and logs from the failed step.
- Handle GitHub's short-lived log redirect separately from the fixed-origin JSON
  client: never forward credentials to the download host; validate redirect
  destinations, enforce byte/time limits, and never persist signed URLs.
- Produce numbered evidence excerpts and hashes. Redact credentials, tokens,
  addresses, and control characters before inference or public storage.
- Verify required-job dependencies in the same run/attempt. Do not evaluate
  arbitrary workflow expressions or execute producer code.

**Acceptance Criteria:**
- Same-run required prerequisite failure gives `method: deterministic` and
  `certainty: verified`; a different run/attempt cannot explain the skip.
- Hidden-variable skips and unavailable/expired logs give `certainty: unknown`,
  not a hardware-outage claim.
- **ASSUMPTION:** Fetch at most 5 job-log/report documents per incident, each at
  most 2 MiB, and send at most 48 KiB of selected evidence to the model.
- Secret-canary fixtures appear zero times in model requests, logs, or public
  artifacts. Blocked/inaccessible evidence returns an explicit availability code.

### Phase 2: Qualify a bounded local model client

**Depends on:** Phase 1 and authorized runner access.

**Changes:**
- Reuse the existing runner's loopback/ephemeral-port, persistent-cache, health
  check, and process-cleanup practices, not its repository-write agent setup.
- Pin the model recipe/checkpoint and server version. Make a plain chat request
  against the pinned server's documented API [S9].
- Treat supplied logs as untrusted quoted data. Give the model no tools,
  GitHub token, network-fetch capability, or ability to execute instructions.
- Request JSON with a concise cause, category, certainty, and evidence IDs;
  enforce the schema and citation membership in application code. Reject active
  mentions/HTML and build public links from verified metadata, not model URLs.
- The pinned API documentation does not establish constrained JSON-schema output
  support. Do not rely on newer API features without executing a compatibility test.

**Acceptance Criteria:**
- Successful output has `method: model`, `certainty: likely`, a cause of at most
  160 characters, and at least one valid evidence ID. A model cannot set verified.
- Unsupported citations, malformed JSON, prompt-injection requests, and missing
  evidence produce `certainty: unknown`; no generated command is executed.
  A model-generated mention cannot produce a new GitHub notification.
- **ASSUMPTION:** One request per uncached evidence set, 120-second request timeout,
  at most 1,500 generated tokens, and a 10-minute total diagnosis-job timeout.
- On 20 reviewed fixtures (10 failures, 5 skips, 5 insufficient/adversarial cases),
  at least 90% of emitted likely causes are evidence-supported; fabricated verified
  causes and accepted invalid citations both equal zero. Otherwise keep disabled.

### Phase 3: Persist and publish optional enrichment

**Depends on:** Phases 1 and 2.

**Changes:**
- Gate analysis independently of GitHub notifications, off by default. Keep the
  existing incident opening/initial mentions ahead of model work.
- Cache by incident + observation + evidence hash + analyzer/prompt/model version.
  Keep the validated short result, provenance and evidence references, not raw logs.
- Publish from a trusted writer after validating the diagnosis artifact; the
  inference job has read-only access and no recipient configuration.
- Update the same issue and existing tooltip Finding row. Prefix model hypotheses
  with "Likely:"; retain the generic finding if no supported cause exists.

**Acceptance Criteria:**
- Same inputs yield zero extra model requests and zero extra issue mentions;
  changed evidence/rerun causes one new bounded analysis.
- A stale result cannot replace a newer observation's finding. Original pass/fail,
  qualification, incident identity, and routing state remain unchanged.
- Model timeout, inaccessible runner, invalid output, or publication failure
  leaves the original issue and usable dashboard data intact.
- Healthy cells gain no diagnosis rows or panels; older datasets still load.

### Phase 4: Controlled rollout

**Depends on:** Phase 3 and pilot evidence.

**Changes:**
- Run an authorized fixture-only inference pilot first, then read-only analysis
  of a small approved public incident set. Reserve shared hardware before testing.
- Compare deterministic-only and model-assisted explanations using the same
  evidence; record correctness, unsupported claims, request latency, and failures.
- Enable public enrichment only after review. Keep rollback independent from
  normal notifications; no real recipient pings are needed for model evaluation.

**Acceptance Criteria:**
- Pilot passes Phase 2's quality/safety limits and the configured timeouts.
- Disabling analysis makes zero model requests and preserves ordinary GitHub
  notifications. No direct email or collector-monitoring workflow is introduced.

## Risks and Open Questions

- **Runner access/contention:** Confirm repository eligibility, owner, lease, and
  available memory before inference; never commandeer the existing benchmark jobs.
- **Unknown skips:** Evaluated secret/variable values may be unavailable forever;
  unresolved is a valid result, never permission to invent a cause.
- **Model/log injection or leakage:** No tools; public allowlist, strict budgets,
  redaction, validated citations, and a trusted publication boundary.
- **Unsupported reasoning:** Citations establish provenance, not correctness;
  deterministic verification and reviewed pilot precision remain separate gates.
- **Model/runtime compatibility:** The existing deployment succeeded on review
  tasks; diagnosis quality, JSON behavior, and token/latency settings need testing.

## Research Sources

Inspected on 2026-11-18. Source dates are commit/run timestamps; documentation
publication dates are otherwise unavailable.

- **S1:** [Lemonade Repo Manager workflow](https://github.com/lemonade-sdk/lemonade/blob/4d0568a13bd11a80b6287c759ead45bdac3a3596/.github/workflows/repo-manager.yml).
- **S2:** [Reusable action](https://github.com/lemonade-sdk/lemonade/blob/4d0568a13bd11a80b6287c759ead45bdac3a3596/.github/actions/repo-manager/action.yml).
- **S3:** [Central model/server pins](https://github.com/lemonade-sdk/lemonade-testing/blob/5ab75121accb0c8c89194fdfe2e0a8c81aa4ff9d/runner/pin.env).
- **S4:** [Runner startup and lifecycle](https://github.com/lemonade-sdk/lemonade-testing/blob/5ab75121accb0c8c89194fdfe2e0a8c81aa4ff9d/runner/run.sh).
- **S5:** [Successful run and job logs](https://github.com/lemonade-sdk/lemonade/actions/runs/44299703380/job/134786150319) explicitly show the model pulled and selected.
- **S6:** [Existing backend benchmark](https://github.com/lemonade-sdk/lemonade/blob/4d0568a13bd11a80b6287c759ead45bdac3a3596/.github/workflows/benchmark-regression.yml).
- **S7:** [Downstream nightly failure alert](https://github.com/lemonade-sdk/llamacpp-rocm/blob/17e6bd68675faec1a2fa99a27871f52c0cd4e484/.github/workflows/nightly-failure-alert.yml).
- **S8:** [Repo Manager v1.1.0 commands](https://github.com/lemonade-sdk/repo-manager/blob/v1.1.0/README.md#commands).
- **S9:** [Lemonade 11.9.0 chat API](https://github.com/lemonade-sdk/lemonade/blob/bb39eafc22aa7e57fc7aeb8b7d384d70b44a4531/docs/api/openai.md).
- **S10:** [GitHub job/log and run-attempt APIs](https://docs.github.com/en/rest/actions/workflow-jobs).

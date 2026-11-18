# Evidence-backed CI diagnosis

The processing order is **rules → Lemonade diagnosis → unresolved GitHub escalation**.
Diagnosis adds evidence and a short Finding; it never changes the producer verdict.

## Rules first

The existing alert evaluator handles permitted skips, verified same-run/attempt
prerequisite failures, expected inactivity, and configured exceptions. These known
explanations require no model request or new investigation. A narrowly matched
outcome response may declare `explains_cause: true` for a maintainer-established
cause. Generic “tests failed”, step names, and cancellation status do not establish
an underlying cause.

## Investigate unexplained results

`scripts/diagnosis_evidence.py` checks configured public repositories and preserves
repository/run/attempt/job/revision provenance. It reads the exact attempt's jobs,
job log, workflow at that revision, and pinned qualification report when available.
The model can request bounded log pages/searches, run jobs, workflow, and report.
It cannot select another incident, execute commands, rerun jobs, or write issues.

Limits are five evidence documents, 2 MiB per document, 48 KiB of selected text,
and bounded network requests. Credentials, addresses, and terminal controls are
redacted. Log redirects receive no GitHub credential; signed URLs are not stored.
Private repositories and unknown historical attempts remain unavailable evidence.
Missing builds cannot be explained by inventing a runner outage.

`scripts/diagnosis_model.py` uses **Qwen3.6-35B-A3B-MTP-GGUF** through a loopback
Lemonade server. Its read-tool loop has a 120-second deadline, at most five tool
calls, and at most 1,500 generated output tokens in aggregate. Each response can
use up to 1,000 tokens; valid server usage deducts the tokens actually generated,
including reasoning. Missing usage deducts the full requested allowance. Supported results
contain a cause of at most 160 characters and valid numbered evidence references.
Model certainty is `likely`, never `verified`; malformed, generic, unsupported,
or unavailable output becomes `unknown`. Citation validation establishes source
membership; real diagnosis accuracy requires a reviewed model evaluation.
For skipped jobs, model claims about historical `vars` or `secrets` remain
unresolved unless existing verified rules already explain them. Dot and bracket
references are checked again at the trusted writer; an unrelated secret used by
another step does not block an independently evidenced prerequisite explanation.
A model skip explanation must also cite exact same-attempt prerequisite outcomes
and a complete workflow job definition at the run revision that proves the gate.
Ambiguous YAML, incomplete excerpts, and tolerated prerequisite failures stay unknown.
Supported dependency skips use a fixed sentence derived from the proof before
inference. This includes unambiguous matrix jobs and status-free expressions
subject to GitHub's implicit success gate. The complete job-label registry is
checked to reject ambiguous matrix bindings. Hidden input values are not inferred;
status-function overrides and tolerated failures remain conservative.
Cancelled jobs stay unknown when existing rules cannot explain them: the current
packet contains no verified actor or evaluated cancellation trigger. A cancellation
status, manual-trigger capability or concurrency setting cannot establish why it stopped.
The runner persists a bounded evidence-rules artifact before checking or starting
Lemonade. Known-only datasets need no model setup; if provisioning fails, verified
findings remain available and unresolved cases retain investigation.
The literal linker error that `mt.exe` cannot be found in PATH is explained by a
deterministic runtime rule before inference; it does not infer installation state
or the tool's purpose. Explicit unavailable-version and invalid build-tool ZIP
diagnostics are also handled by rules. Literal runtime rules require matching
timestamps inside a recorded failed step of the same job; errors in successful
optional steps cannot explain a later failure.
Run-command echoes are excluded from log evidence. Runtime errors and failed-step
output take priority; a failed document read does not block other documents.
Workflow reads support bounded line paging or a complete projection of named-job
gating fields and direct prerequisites, excluding large step bodies.
The prompt requests one sentence for a nontechnical director. One format/length
correction is allowed inside the existing time, round and generated-token budgets;
the corrected answer must pass the same evidence and output checks. Generic build
subjects omit optional GPU/CPU/NPU adjectives so model phrasing cannot invent the
job target; the existing portal scope supplies that context.
The client uses Qwen's direct-answer sampling preset (temperature 0.7, top-p 0.8,
presence penalty 1.5, thinking disabled). The Strix Halo pilot verified this API
option and tool calls on Lemonade 11.9.0. Thinking mode sometimes exhausted the
short budget on repetitive reasoning. The application preloads relevant logs and
workflow evidence; the model requests additional reads only when needed. Repeated
reads reference existing evidence IDs without discarding earlier assistant context.
See the [model's sampling guidance](https://huggingface.co/Qwen/Qwen3.6-35B-A3B#best-practices).

## Publish findings, escalate unknowns

`scripts/diagnosis.py` runs known rules before inference and sets
`escalation_required` independently from qualification/actionability. A supported
cause appears as a direct, concise sentence in the existing Finding. Model
provenance and certainty remain in the retained data without a visible prefix.
Unresolved actionable cases create/reuse the ordinary deduplicated GitHub issue.
After saved GitHub acceptance the UI shows “Investigation pending.” and the issue
link. Failed delivery does not claim an issue was accepted. Healthy tooltips gain
no panels or rows. Direct email remains deferred.

Cache identity includes incident, observation, evidence, and analyzer/prompt/model
versions. Read-tool evidence is replayed and checked. Reruns/corrections cannot
reuse a stale finding. The cache contains validated short outcomes and bounded
tool arguments, not prompts or raw logs. The normal publisher preserves it.

## Workflow and setup

Analysis is independently disabled unless `ROCM_READINESS_DIAGNOSIS_ENABLED` is
`true`. The hosted notification workflow requests `diagnosis.yml` and waits at
most eight minutes, including runner queue time. Failure or timeout falls back
to unresolved escalation; a matching pending child is cancelled. Producer data
was already published before this process begins.

The child workflow has only repository/actions read permissions, no recipient
secret, and no issue-write permission. The hosted writer re-fetches and validates
evidence, observation identity, model/analyzer versions, and artifact hashes before
accepting a finding. Missing, invalid, stale, or unavailable artifacts cannot
suppress an investigation.

Before enabling, the runner owner must:

1. Confirm repository access and exclusive capacity/reservation policy. Set
   `ROCM_READINESS_DIAGNOSIS_RUNNER` to a JSON array of approved runner labels.
   No existing benchmark machine is implicitly authorized.
2. Provision `lemond` **11.9.0**, Python 3.12 or later, curl, and a persistent cache
   path in `ROCM_READINESS_MODEL_CACHE`. Protect the `diagnosis` environment for
   trusted main-only execution. The runner script starts an isolated loopback
   server with isolated temporary user configuration, uses only its own PID for
   cleanup, and pulls the pinned model recipe with a 32K Vulkan context.
3. Run an authorized, reserved-runner evaluation before setting the enable variable.
   Check API/tool compatibility, thinking behavior, context/memory, latency,
   supported explanations, and correctly unresolved cases. The serving pattern
   must match the qualified recipe; fixture results and isolated public cases do
   not establish broad production accuracy.

Notification delivery retains its separate protected environment and enable flag.
Disabling diagnosis makes no model requests; known rules still explain known
cases and unresolved actionable cases remain eligible for ordinary notifications.
No automatic fixes, reruns, external-provider fallback, or collector watchdog exist.

## Local and fixture checks

```sh
python3 -m unittest tests.test_diagnosis tests.test_diagnosis_evidence tests.test_diagnosis_model -q
python3 scripts/notify.py --dataset data --output data/notifications-preview.json
# Against a separately authorized local server; sends no team notifications:
python3 scripts/notify.py --dataset data --diagnose --diagnose-only data/diagnosis-results.json
```

A real model evaluation must cover reviewed failures, skips, and insufficient or
adversarial evidence. Measure evidence-supported explanations and incorrect
suppression/escalation, not the model's self-reported confidence. The initial
20-case target is 10 failures, 5 skips, and 5 insufficient/adversarial cases;
at least 90% of emitted explanations must be supported, with zero fabricated
verified causes, accepted invalid citations, or secret-canary leaks. Leave
analysis disabled if it does not pass.

## Existing serving pattern

- [Runner pins](https://github.com/lemonade-sdk/lemonade-testing/blob/5ab75121accb0c8c89194fdfe2e0a8c81aa4ff9d/runner/pin.env).
- [Runner lifecycle](https://github.com/lemonade-sdk/lemonade-testing/blob/5ab75121accb0c8c89194fdfe2e0a8c81aa4ff9d/runner/run.sh).
- [Lemonade 11.9.0 API](https://github.com/lemonade-sdk/lemonade/blob/bb39eafc22aa7e57fc7aeb8b7d384d70b44a4531/docs/api/openai.md).

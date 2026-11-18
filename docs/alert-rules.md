# Alert rules

Edit [`alert-rules.json`](../alert-rules.json) to configure upstream build alerts.
Evaluation runs after successful collection/publication; there is no independent
schedule or monitoring of our collector's freshness/outages. Delivery and setup
are covered in [notifications](notifications.md).

## Defaults

| Scope | Policy |
| --- | --- |
| Producer results | Alert on the latest failure, warning, cancellation, or unexplained skip. Preserve producer qualification verdicts. |
| Nightly builds | Monitor the latest numeric nightly track for `llamacpp-nightly-qualification`; monitoring of retained tracks is paused, not declared retired. Alert when monitored producer evidence exceeds 48 hours and complete collection covers that deadline. |
| Unsloth | Alert below 80% passing per job over 30 days, with at least one decided run. Exactly 80% does not alert. |

Pass rate counts pass + fail outcomes per distinct workflow run; the latest
attempt wins. Timeouts/action-required count as failures. Cancelled, skipped,
running, neutral, and unknown outcomes are excluded. Zero decided results means
unknown, not 0%; incomplete window coverage cannot establish a rate or recovery.
Historical gaps alone never establish a schedule or permitted inactivity.

## Configuration

The document has `schema_version: 1`, `current_nightly_tracks`, and `rules`.
Each rule requires a unique `id`, positive `version`, and `kind`; `enabled`
defaults to true and `match` defaults to all scopes.
`incident_labels` maps exact source IDs to existing engine/project labels for
GitHub issues; for example, `llamacpp-upstream` maps to `engine:llamacpp`.
`current_nightly_tracks` accepts `latest` (the default llama.cpp policy) or a pinned
numeric version. `latest` selects the highest numeric published nightly version
for that source's repository; older snapshots without matching release metadata
fall back to observed nightly builds. Minor and patch versions compare numerically:
`10.4.5` follows `10.4`, and `10.10` follows `10.9`. Both the monitored scope and
the `{current_track}` wording update on the next collection, without editing code
or rule text. The policy does not infer that older-track builds have stopped.

`match` accepts exact strings or nonempty lists for `repository`, `source_id`,
`workflow`, `job`, `channel`, `platform`, `target`, and `rocm_version`.
Upstream sources use `<project.id>-upstream`, workflow filenames, and configured
job IDs. Readiness platform/target come from `os`/`gfx_target`.

| Kind | Required policy |
| --- | --- |
| `result` | `outcomes`, `recovery_states`, `expected_status`, and `skip` (below). |
| `pass_rate` | `threshold_percent` (0–100), positive `window_days`, and integer `minimum_samples` ≥ 1. |
| `missing` | Exactly one of `max_age_hours`, `schedule`, or `event_driven: true`; optional nonnegative `grace_hours`. |

Missing rules can define `older_track_response: {summary, explanation}` with
`{track}` and `{current_track}` placeholders. For a retained nightly track outside
`current_nightly_tracks`, this supplies an expected-inactivity explanation to
empty calendar cells in that exact source/track/platform. It does not annotate
observed builds, infer retirement, create an incident, or establish recovery.
These assessments use `applies_to: missing_observation` without a date; only
empty-cell controls may match them. Ordinary incident assessments still require
an exact date and every supplied scope constraint.

A `schedule` specifies an IANA `timezone`, `weekdays` (Monday 0–Sunday 6), and
local `time` (`HH:MM`). Adopt only verified/approved expectations. Missing work
alerts strictly **after** deadline + grace, once complete collection covers it.
Event-driven rules require recorded
`eligible_event: {verified: true, eligible: true, at: <timestamp>, url: <evidence>}`;
the collector does not reconstruct historical path-filter eligibility.

Optional `exceptions` contain a nonempty `match`, `reason`, and timezone-aware
`from`/`until` timestamps (inclusive/exclusive). Do not overlap same-kind rules
for one scope. Increment `version` when changing policy or wording.

### Result responses

Use the shipped result rule as the complete example:

- `outcomes` maps normalized `status` to stable `anomaly` names. Each has
  `responses` for `active`, `with_details`, `recovered`, and `suppressed`.
  Optional `with_failed_step` uses a recorded failed step. `failed_steps` can
  restrict it to exact step names, so test-failure wording does not describe
  compile or other failures.
- `recovery_states` lists final states that can prove an anomaly absent;
  `expected_status` supplies the published expectation. Running/unknown work
  cannot prove recovery.
- `skip` defines its status/anomaly, expectation, and responses for `permitted`,
  `dependency`, `unexplained`, and `recovered`. Its `dependency_anomaly` references
  an outcome in the same rule for prerequisite matching and incident correlation.

Every response contains `classification`, `summary`, and `explanation`.
An outcome response may also set `explains_cause: true` when a narrowly matched,
maintainer-established rule actually explains the cause. That response bypasses
Lemonade and GitHub escalation. Leave it absent for generic result or failed-step
wording; “Some tests in the job have failed.” alone does not establish why.
Verified permitted/dependency skips and expected inactivity also bypass inference.
Text supports `{status}`, `{matched_status}`, `{details}`, `{reason}`, and
`{exception}` only. Classifications are `expected`, `explained_abnormal`, or
`unexplained`, validated against the evidence case. Invalid/duplicate mappings,
missing responses, and unsupported templates are rejected before evaluation.
Keep anomaly names unchanged for wording-only edits: they define incident IDs.

## Evidence and recovery

Python normalizes source statuses and verifies evidence; rules select matches
and response text. A permitted skip needs `verified_skip` with `verified`,
`permitted`, `reason`, a run-revision `workflow_url`, and an evaluated `event_url`.
A dependency skip needs `verified_dependencies` with `verified`, `workflow_url`,
and required `jobs`, plus a matching prerequisite in the same repository,
workflow, run, and attempt. It links to that incident rather than alerting twice.
Unknown conditions remain unexplained; hidden runner values are never inferred.

Assessments contain stable `id`, `rule_id`/`rule_version`, `evaluated_at`, scope,
actionability/classification, summary/explanation, observed/expected values,
and evidence links. `observation_id` changes for reruns/corrections; incident
identity excludes date and rule version. Only current scopes/latest results
are assessed, not every historical failure.

Recovery requires a same-ID non-actionable assessment with
`classification: expected` and `observed.complete: true`. Partial coverage,
failed attempts, unknown rates, missing events, disabled rules, or evaluation
errors are not recovery. Live sync metadata guards against using retained
last-good data as new proof; it never creates collector alerts.

## Verify changes

Add fixed-time cases to [test_assessments.py](../tests/test_assessments.py), then:

```sh
python3 -m unittest tests.test_assessments -q
python3 scripts/notify.py --dataset data --output /tmp/readiness-notification-preview.json
```

The preview sends nothing. Missing/malformed datasets must report evaluation
errors, not fabricated incidents or recovery.

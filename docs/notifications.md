# Build-issue notifications

After successful trusted main-branch collection/publication, evaluate collected
upstream results, apply known rules, and diagnose unexplained outcomes before
creating a GitHub investigation. Normal data publication
does not wait for notification delivery. There is no collector watchdog or
independent notification schedule. Direct email remains deferred in #97.

See [alert rules](alert-rules.md) for classifications and
[setup](notification-setup.md) for private routing and safe rollout.

## Visible behavior

- Known rule explanations bypass inference and issue creation. Remaining actionable
  failures, warnings, cancellations, skips, and due missing builds are eligible for
  bounded Lemonade diagnosis. Only unresolved cases dispatch a GitHub investigation.
  Normal/not-yet-due gaps do not. See [CI diagnosis](specs/ci-failure-diagnosis.md).
- Incidents receive `bug`, `upstream-incident`, and configured engine/project
  labels. All configured targets are mentioned in the initial body; no automatic
  assignment is performed.
- Matching status tooltips add one concise Finding sentence and an Investigation row with the
  exact issue link. Supported explanations use direct cause text; accepted unresolved
  escalations show “Investigation pending.” Healthy tooltips stay unchanged. Pending/failed dispatch must
  never claim the team was notified; transient creation/retry states stay in CI
  logs and persisted data, not tooltip messages.
- GitHub acceptance means dispatch accepted, not reading or acknowledgment.
  Any native GitHub email depends on recipient settings.

CI writes the accepted issue URL and notification outcome before publication.
The static page reads that saved outcome on load; it does not need a live
connection to the running job. Legacy accepted notifications retain “Team notified.”
An existing investigation link remains usable even if a later retry fails.
Incident titles name
the repository and job; bodies include affected workflow/platform/target/date,
recorded findings, evidence links, and follow-up. CI activity is the dashboard's
collected runs, results, and job-log view.

## Lifecycle

Incident IDs describe source/workflow/job/channel/platform/target and anomaly,
not editable issue titles or collection dates.

- The first live run baselines existing abnormalities without a historical flood.
  A previously healthy scope becoming abnormal is new work.
- Repeated observations reuse the issue without another initial mention.
- Recovery requires an explicit same-ID, complete, expected assessment.
  Missing/partial observations, disabled rules, and evaluation errors are not recovery.
- Recurrence reopens the existing investigation without another initial mention.
  There are no automatic reminders or escalations.

The live workflow serializes with collection/publication; local dispatchers use
a file lock. Before every external write, a Git checkpoint persists intent.
A rejected checkpoint prevents sending. Acceptance is checkpointed afterward.
Lost responses and local-state loss reconcile all-state issue body markers before
creating; titles and search indexing are not used for identity.

Known rejections retry with 2–60 minute exponential backoff, at most five attempts.
Retries occur at the next collection or authorized manual run, not on a timer.
Ambiguous responses remain explicit and reconcile before retrying.

## Persistence and operations

`data/notification-state.json` is the public, recipient-free lifecycle/retry ledger.
`data/notifications.json` contains public assessments and GitHub dispatch state.
`data/diagnosis-cache.json` retains validated short outcomes and bounded read-tool
arguments keyed by evidence, observation, and analyzer/model versions; it contains
no raw logs or prompts. The normal publisher preserves these files; `latest.json.notifications_url` lets delivery
updates remain visible independently of the pinned producer dataset.
Legacy disabled-email markers are retained for existing previews, not delivery.

Repository maintainers own recovery. After correcting a rejected request, pause
dispatch, reset that incident's GitHub `attempts`, and remove `next_retry_at`.
Do not delete the whole ledger to retry one incident. An invalid ledger is logged
and quarantined with a blocked marker so producer publication can continue;
restore verified history before clearing it. Never put tokens, recipients, or raw
API errors in public state.

Local previews send nothing. A controlled live test or production enablement
requires separate authorization through the protected workflow described in
[setup](notification-setup.md).

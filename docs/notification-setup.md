# GitHub notification setup

GitHub issues and body mentions are the only delivery channel. Direct email is
deferred in #97. GitHub's native emails follow recipient settings; no mail
provider or sender credentials are required.

## Routing secret

Store approved routing in the Actions secret `ROCM_READINESS_NOTIFICATION_LIST`:

```json
{
  "schema_version": 1,
  "github": {
    "enabled": true,
    "targets": ["fixture-owner", "fixture-reviewer", "fixture-maintainer"]
  }
}
```

These are fixtures. Actual recipients remain in the secret, not source files,
logs, or dashboard datasets. They appear only as initial mentions in incidents.
New issues are unassigned; existing human assignments are preserved.

- Targets are bare usernames or `organization/team` slugs, without `@`.
- Enabled routing requires targets. Entries are validated and deduplicated.
- Optional `scopes` restrict routing to exact source IDs; omission means all.
  An explicitly empty scope list is rejected.
- Missing/invalid configuration means unavailable delivery, never success.
- The already-provisioned `email: {enabled: false, recipients: []}` and empty
  `github.assignees` fields remain accepted for compatibility. Enabled email,
  email recipients, and automatic assignees are rejected.

The repository owner maintains the list and verifies target access and any team
mention settings. Verify secret existence by name without printing its value.

## Rollout

Diagnosis has its own enable variable, approved runner, and reviewed model pilot.
Review runner and model configuration in the [diagnosis workflow](../.github/workflows/diagnosis.yml)
before enabling analysis. Known rules run first; only unresolved actionable cases create team
investigations. Diagnosis failure falls back to that same unresolved path.

1. Verify `bug`, `upstream-incident`, and labels selected by
   `alert-rules.json.incident_labels`. Existing `engine:*` labels are reused.
2. Protect the `notifications` environment with approved reviewers and main-only
   deployment rules. The live job needs `issues: write` and `contents: write`;
   PR/fork runs cannot dispatch.
3. Keep `ROCM_READINESS_NOTIFICATIONS_ENABLED` unset until a controlled test is
   separately authorized. Recipient configuration alone does not permit sending.
4. For that test, provision `ROCM_READINESS_TEST_NOTIFICATION_LIST` with only
   approved test targets. Manually run the notification workflow with `live: true`
   and a unique `test_id`. It never falls back to production recipients or
   consumes the production baseline. Sanitized acceptance evidence lasts seven days.
5. After verification and approval, set repository variable
   `ROCM_READINESS_NOTIFICATIONS_ENABLED` to `true`. Automatic runs follow
   successful main-branch collection/publication; there is no independent schedule.

Verify one issue, all initial mentions, upstream/engine labels, no automatic
assignment, and no duplicate on retry. API acceptance is not proof of reading.
This guide does not authorize or send a live test.

## Offline checks

```sh
python3 -m unittest tests.test_notification_channels tests.test_notifications tests.test_notify -q
python3 scripts/notify.py --dataset data --output /tmp/readiness-notification-preview.json
```

Tests use fake APIs. See [notification lifecycle](notifications.md) for retry and
recovery policy, and [alert rules](alert-rules.md) for evaluation.

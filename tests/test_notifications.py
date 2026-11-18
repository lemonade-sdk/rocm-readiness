from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from scripts.notifications import dispatch, validate_state


NOW = datetime(2026, 11, 17, tzinfo=timezone.utc)
POLICY = {"github": {"enabled": True}}


def assessment(identity="incident", actionable=True):
    return {
        "id": identity, "actionable": actionable, "scope": {"source_id": "test"},
        "classification": "unexplained" if actionable else "expected",
        "observed": {"complete": True},
    }


class NotificationsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.json"

    def run_dispatch(self, **kwargs):
        options = dict(
            policy=POLICY, trusted=True, dry_run=False, baseline=False,
            github=lambda a, i: {"status": "sent", "url": "https://github.com/o/r/issues/1"},
        )
        options.update(kwargs)
        return dispatch([assessment()], self.path, NOW, **options)

    def test_explained_recurrence_reopens_lifecycle_without_sending(self):
        self.run_dispatch()
        dispatch([assessment(actionable=False)], self.path, NOW,
                 policy=POLICY, trusted=True, dry_run=False)
        dispatch([{**assessment(), "escalation_required": False}], self.path, NOW,
                 policy=POLICY, trusted=True, dry_run=False,
                 github=lambda a, i: self.fail("explained recurrence sent"))
        state = json.loads(self.path.read_text())["incidents"]["incident"]
        self.assertEqual(state["lifecycle"], "open")

    def test_explained_first_observation_is_not_baselined_or_marked_recovered(self):
        known = {**assessment(), "escalation_required": False}
        dispatch([known], self.path, NOW, policy=POLICY, trusted=True, dry_run=False,
                 baseline=True, github=lambda a, i: self.fail("explained issue sent"))
        state = json.loads(self.path.read_text())["incidents"]["incident"]
        self.assertFalse(state["baseline"])
        self.assertEqual(state["lifecycle"], "open")
        calls = []
        dispatch([{**assessment(), "escalation_required": True}], self.path, NOW,
                 policy=POLICY, trusted=True, dry_run=False, baseline=True,
                 github=lambda a, i: calls.append(a) or {"status": "sent"})
        self.assertEqual(len(calls), 1)

    def test_github_retries_survive_restart(self):
        calls = []

        def github(a, i):
            calls.append("github")
            return {"status": "failed"}

        first = self.run_dispatch(github=github)
        self.assertEqual(calls, ["github"])
        self.assertEqual(first["assessments"][0]["notification"]["status"], "failed")
        later = datetime(2026, 11, 18, tzinfo=timezone.utc)
        second = dispatch(
            [assessment()], self.path, later, policy=POLICY, trusted=True,
            dry_run=False, baseline=False,
            github=lambda a, i: {"status": "sent"},
        )
        self.assertEqual(second["assessments"][0]["notification"]["status"], "sent")

    def test_overlapping_dispatchers_send_once(self):
        calls = []

        def sender(a, i):
            calls.append("send")
            return {"status": "sent"}

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.run_dispatch, github=sender)
                       for _ in range(2)]
            for future in futures:
                future.result()
        self.assertEqual(len(calls), 1)

    def test_preview_and_untrusted_do_not_modify_state_or_send(self):
        for options in ({"dry_run": True}, {"trusted": False}):
            result = self.run_dispatch(
                github=lambda a, i: self.fail("preview sent"), **options,
            )
            self.assertTrue(result["dry_run"])
            self.assertFalse(self.path.exists())

    def test_initial_baseline_and_recovery(self):
        self.run_dispatch(baseline=True, github=lambda a, i: self.fail("backlog"))
        dispatch([assessment(actionable=False)], self.path, NOW,
                 trusted=True, dry_run=False)
        state = json.loads(self.path.read_text())
        self.assertEqual(state["incidents"]["incident"]["lifecycle"], "recovered")
        self.run_dispatch()
        self.assertEqual(json.loads(self.path.read_text())["incidents"]["incident"]["github"]["status"], "sent")

    def test_baseline_recovers_existing_investigation_without_resending(self):
        result = self.run_dispatch(
            baseline=True,
            reconcile=lambda a: {"status": "sent", "url": "https://github.com/o/r/issues/1"},
            github=lambda a, i: self.fail("baseline wrote to GitHub"),
        )
        notification = result["assessments"][0]["notification"]
        self.assertEqual(notification["github"]["status"], "sent")
        self.assertEqual(notification["email"]["status"], "disabled")

    def test_controlled_test_does_not_consume_production_baseline(self):
        self.run_dispatch(initialize=False)
        self.assertNotIn("initialized_at", json.loads(self.path.read_text()))
        dispatch(
            [assessment("production")], self.path, NOW, trusted=True, dry_run=False,
            policy=POLICY, github=lambda a, i: self.fail("production backlog"),
        )
        self.assertTrue(json.loads(self.path.read_text())["incidents"]["production"]["baseline"])

    def test_initial_healthy_scope_can_alert_later(self):
        dispatch([assessment(actionable=False)], self.path, NOW,
                 trusted=True, dry_run=False)
        result = self.run_dispatch()
        self.assertEqual(result["assessments"][0]["notification"]["status"], "sent")

    def test_incomplete_nonactionable_assessment_is_not_recovery(self):
        self.run_dispatch()
        unknown = {**assessment(actionable=False), "classification": "unexplained",
                   "observed": {"complete": False}}
        dispatch([unknown], self.path, NOW, trusted=True, dry_run=False)
        self.assertEqual(json.loads(self.path.read_text())["incidents"]["incident"]["lifecycle"], "open")

    def test_causal_skip_reuses_parent_incident(self):
        sent = []

        def sender(a, i):
            sent.append(a["id"])
            return {"status": "sent", "url": "https://github.com/o/r/issues/1"}

        correlated = {**assessment("skip"), "causal_incident_id": "incident"}
        result = dispatch(
            [correlated, assessment()], self.path, NOW,
            policy=POLICY, trusted=True, dry_run=False, baseline=False,
            github=sender,
        )
        self.assertEqual(sent, ["incident"])
        self.assertEqual(result["assessments"][0]["notification"],
                         result["assessments"][1]["notification"])

    def test_missing_and_disabled_configuration_never_claim_success(self):
        result = self.run_dispatch(policy={"github": {"enabled": False}})
        status = result["assessments"][0]["notification"]
        self.assertEqual(status["github"]["status"], "disabled")
        self.assertEqual(status["email"]["status"], "disabled")
        self.assertEqual(status["status"], "pending")

    def test_scope_and_retry_budget(self):
        result = self.run_dispatch(
            policy={"github": {"enabled": True, "scopes": ["other"]}},
        )
        self.assertEqual(result["assessments"][0]["notification"]["github"]["status"], "disabled")
        self.run_dispatch(max_attempts=0, github=lambda a, i: self.fail("budget"))
        self.assertEqual(json.loads(self.path.read_text())["incidents"]["incident"]["github"]["status"], "failed")

    def test_lost_github_response_reconciles_on_retry(self):
        def lost(a, i):
            raise TimeoutError("private transport detail")

        first = self.run_dispatch(github=lost)
        self.assertEqual(first["assessments"][0]["notification"]["github"]["status"], "uncertain")
        second = self.run_dispatch()
        self.assertEqual(second["assessments"][0]["notification"]["github"]["status"], "sent")

    def test_durable_intent_precedes_each_side_effect(self):
        checkpoints = []

        def checkpoint():
            checkpoints.append(json.loads(self.path.read_text()))

        def sender(a, i):
            self.assertTrue(checkpoints)
            self.assertEqual(checkpoints[-1]["incidents"]["incident"]["github"]["status"], "uncertain")
            return {"status": "sent"}

        self.run_dispatch(github=sender, checkpoint=checkpoint)
        self.assertEqual(len(checkpoints), 3)

    def test_failed_intent_persistence_prevents_sending(self):
        def failed_checkpoint():
            raise ConnectionError("remote state write failed")

        with self.assertRaises(ConnectionError):
            self.run_dispatch(
                checkpoint=failed_checkpoint,
                github=lambda a, i: self.fail("unpersisted send"),
            )

    def test_public_ledger_rejects_recipient_configuration(self):
        self.run_dispatch()
        state = json.loads(self.path.read_text())
        state["recipients"] = ["private@example.test"]
        with self.assertRaisesRegex(ValueError, "invalid notification state"):
            validate_state(state)
        state.pop("recipients")
        state["incidents"]["incident"]["first_seen_at"] = {"recipients": ["private@example.test"]}
        with self.assertRaisesRegex(ValueError, "invalid notification incident"):
            validate_state(state)

    def test_quarantined_ledger_cannot_reset_into_new_sends(self):
        self.path.write_text(json.dumps({
            "schema_version": 1, "incidents": {}, "blocked": True,
        }))
        with self.assertRaisesRegex(ValueError, "operator recovery"):
            self.run_dispatch(github=lambda a, i: self.fail("quarantined dispatch"))


if __name__ == "__main__":
    unittest.main()

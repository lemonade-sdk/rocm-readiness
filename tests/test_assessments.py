import copy
import json
from pathlib import Path
import shutil
import unittest
import uuid

from scripts import assessments
from scripts.dataset import _write_json


NOW = "2026-11-17T15:00:00Z"


def rule(kind="result", **changes):
    value = {"id": kind, "version": 1, "kind": kind, "enabled": True}
    if kind == "result":
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        value.update(next(r for r in config["rules"] if r["kind"] == kind))
        value["id"] = kind
    if kind == "pass_rate":
        value.update(threshold_percent=80, minimum_samples=1, window_days=30)
    if kind == "missing":
        value.update(schedule={"timezone": "UTC", "weekdays": list(range(7)), "time": "13:00"},
                     grace_hours=1)
    value.update(changes)
    return value


def run(conclusion="success", **changes):
    value = {
        "job": "base", "run_id": "100", "attempt": 1,
        "created_at": "2026-11-17T13:00:00Z", "completed_at": "2026-11-17T14:00:00Z",
        "conclusion": conclusion, "state": conclusion, "url": "https://github.com/org/repo/actions/runs/100/job/1",
    }
    value.update(changes)
    return value


def build(state="pass", **changes):
    value = {
        "source_id": "nightly", "run_id": "100", "build_id": "100-linux",
        "channel": "nightly", "rocm_version": "10.3.0", "os": "linux",
        "gfx_target": "gfx1151", "generated_at": "2026-11-17T13:00:00Z",
        "run_attempt": 1, "overall": state, "run_url": "https://github.com/org/repo/actions/runs/100",
    }
    value.update(changes)
    return value


class AssessmentTests(unittest.TestCase):
    def setUp(self):
        # Keep test output inside this checkout, not a shared temporary directory.
        self.root = Path(__file__).parent / (".assessments-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.config = {"schema_version": 1, "rules": [rule()]}

    def dataset(self, rows=(), builds=(), complete=True, coverage=True,
                generated=NOW, collected=None, jobs=None):
        index = {
            "schema_version": 2, "generated_at": generated,
            "collection_status": "complete" if complete else "partial",
            "sources": [{"id": "nightly", "repository": "org/repo", "status": "fresh", "channel": "nightly"}],
            "versions": [{"rocm_version": "10.3.0", "overview": "rocm/overview.json"}],
            "upstream": {"overview": "upstream/overview.json"},
        }
        _write_json(self.root / "index.json", index)
        _write_json(self.root / "rocm/overview.json", {"history": [{"path": "rocm/month.json"}]})
        _write_json(self.root / "rocm/month.json", {"builds": list(builds)})
        jobs = jobs or [{"id": "base", "workflow": "build.yml", "os": "linux", "target": "image"}]
        _write_json(self.root / "upstream/overview.json", {
            "projects": [{"id": "test", "repository": "org/upstream", "jobs": jobs,
                          "coverage": {"complete": coverage, "collected_at": collected or generated},
                          "files": [{"path": "upstream/month.json"}]}],
        })
        _write_json(self.root / "upstream/month.json", {"runs": list(rows)})

    def evaluate(self, rules=None, now=NOW):
        config = copy.deepcopy(self.config)
        if rules is not None:
            config["rules"] = rules
        return assessments.evaluate_dataset(self.root, config, now)

    def one(self, kind, **changes):
        result = self.evaluate([rule(kind, **changes)])
        self.assertEqual(len(result), 1)
        return result[0]

    def test_public_contract_determinism_and_no_recipient_data(self):
        self.dataset([run("failure", failed_step="Compile")])
        first = self.evaluate()
        self.assertEqual(first, self.evaluate())
        active = next(a for a in first if a["actionable"])
        self.assertEqual(len(active["id"]), 64)
        self.assertEqual(active["classification"], "explained_abnormal")
        self.assertEqual(active["scope"]["job"], "base")
        self.assertEqual(active["scope"]["workflow"], "build.yml")
        self.assertEqual(active["scope"]["date"], "2026-11-17")
        self.assertEqual(set(active), {
            "id", "rule_id", "rule_version", "evaluated_at", "actionable", "classification",
            "summary", "explanation", "scope", "observed", "expected", "evidence", "observation_id",
        })

    def test_result_policy_controls_match_responses_and_stable_recovery(self):
        configured = rule()
        configured["outcomes"][0]["status"] = "warn"
        configured["outcomes"][1]["status"] = "fail"
        response = configured["outcomes"][0]["responses"]["active"]
        response.update(summary="Review {status}", explanation="Policy matched {matched_status}.")
        configured["outcomes"][0]["responses"]["recovered"]["summary"] = "Recovered {status}"
        self.dataset([run("warning")])
        active = next(a for a in self.evaluate([configured]) if a["actionable"])
        self.assertEqual(active["summary"], "Review warn")
        self.assertEqual(active["explanation"], "Policy matched warn.")
        self.dataset([run("success")])
        recovered = next(a for a in self.evaluate([configured]) if a["id"] == active["id"])
        self.assertFalse(recovered["actionable"])
        self.assertEqual(recovered["summary"], "Recovered pass")

    def test_skip_responses_come_from_policy_without_relaxing_evidence_checks(self):
        configured = rule()
        configured["skip"]["responses"]["unexplained"].update(
            summary="Investigate skipped job",
            explanation="No verified reason for {status}.",
        )
        self.dataset([run("skipped", verified_skip={"permitted": True, "reason": "Not verified"})])
        active = next(a for a in self.evaluate([configured]) if a["actionable"])
        self.assertEqual(active["summary"], "Investigate skipped job")
        self.assertEqual(active["explanation"], "No verified reason for skip.")
        self.assertEqual(active["classification"], "unexplained")

    def test_result_responses_with_evidence_and_policy_exception_are_configurable(self):
        configured = rule()
        configured["outcomes"][0]["responses"]["with_details"].update(
            summary="Failed build evidence",
            explanation="{details} is the recorded failing step.",
        )
        configured["outcomes"][0]["responses"]["with_failed_step"].update(
            summary="Failed build evidence",
            explanation="{details} is the recorded failing step.",
        )
        configured["outcomes"][0]["responses"]["suppressed"]["explanation"] = "Excluded: {exception}"
        self.dataset([run("failure", failed_step="Compile")])
        failed = next(a for a in self.evaluate([configured]) if a["actionable"])
        self.assertEqual(failed["summary"], "Failed build evidence")
        self.assertEqual(failed["explanation"], "Compile is the recorded failing step.")
        configured["exceptions"] = [{"match": {"job": "base"}, "reason": "Maintenance"}]
        suppressed = next(a for a in self.evaluate([configured]) if a["id"] == failed["id"])
        self.assertFalse(suppressed["actionable"])
        self.assertEqual(suppressed["explanation"], "Excluded: Explicit policy exception: Maintenance")

    def test_recovery_requires_a_configured_final_state(self):
        configured = rule(recovery_states=["pass"])
        self.dataset([run("failure")])
        failed = next(a for a in self.evaluate([configured]) if a["actionable"])
        self.dataset([run("warning")])
        self.assertFalse(any(a["id"] == failed["id"] for a in self.evaluate([configured])))
        self.dataset([run("success")])
        recovered = next(a for a in self.evaluate([configured]) if a["id"] == failed["id"])
        self.assertFalse(recovered["actionable"])

    def test_causal_skip_follows_configured_prerequisite_identity_and_response(self):
        configured = rule()
        configured["outcomes"][0]["anomaly"] = "base_image_failure"
        configured["skip"]["dependency_anomaly"] = "base_image_failure"
        configured["skip"]["responses"]["dependency"]["explanation"] = "Required image failed; investigate its incident."
        configured["skip"]["responses"]["permitted"]["explanation"] = "Verified: {reason}"
        jobs = [
            {"id": "base", "workflow": "build.yml", "os": "linux"},
            {"id": "studio", "workflow": "build.yml", "os": "linux"},
        ]
        skipped = run("skipped", job="studio", verified_dependencies={
            "verified": True, "jobs": ["base"],
            "workflow_url": "https://github.com/org/repo/blob/abc/build.yml",
        })
        self.dataset([run("failure"), skipped], jobs=jobs)
        result = self.evaluate([configured])
        parent = next(a for a in result if a["actionable"])
        child = next(a for a in result if "causal_incident_id" in a)
        self.assertEqual(child["causal_incident_id"], parent["id"])
        self.assertEqual(child["explanation"], "Required image failed; investigate its incident.")
        self.dataset([run("skipped", verified_skip={
            "verified": True, "permitted": True, "reason": "Gate disabled.",
            "workflow_url": "https://github.com/org/repo/blob/abc/build.yml",
            "event_url": "https://github.com/org/repo/actions/runs/100",
        })])
        permitted = self.evaluate([configured])
        self.assertFalse(permitted[0]["actionable"])
        self.assertEqual(permitted[0]["explanation"], "Verified: Gate disabled.")

    def test_invalid_result_policy_is_rejected_before_evaluation(self):
        for field, value in (
            ("outcomes", []), ("recovery_states", ["running"]),
            ("expected_status", ""), ("skip", {}),
        ):
            configured = rule(**{field: value})
            with self.subTest(field=field), self.assertRaises(ValueError):
                assessments.validate_config({"schema_version": 1, "rules": [configured]})
        for template in ("Unknown {recipient}", "{status.__class__}", "{status!r}", "{status:>10}", "{"):
            configured = rule()
            configured["skip"]["responses"]["unexplained"]["explanation"] = template
            with self.subTest(template=template), self.assertRaises(ValueError):
                assessments.validate_config({"schema_version": 1, "rules": [configured]})
        for mutation in ("duplicate", "dangling", "classification", "failed-step"):
            configured = rule()
            if mutation == "duplicate":
                configured["outcomes"][1]["status"] = configured["outcomes"][0]["status"]
            elif mutation == "dangling":
                configured["skip"]["dependency_anomaly"] = "missing_anomaly"
            elif mutation == "classification":
                configured["skip"]["responses"]["unexplained"]["classification"] = "expected"
            else:
                configured["outcomes"][0]["failed_steps"] = [""]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                assessments.validate_config({"schema_version": 1, "rules": [configured]})

    def test_latest_success_avoids_historical_failure_backlog(self):
        self.dataset([run("failure", run_id="99", created_at="2026-11-16T13:00:00Z"), run()])
        self.assertFalse(any(a["actionable"] for a in self.evaluate()))

    def test_failure_to_pass_recovery_keeps_incident_id(self):
        self.dataset([run("failure")])
        failed = next(a for a in self.evaluate() if a["actionable"])
        self.dataset([run("success", attempt=2)])
        recovered = next(a for a in self.evaluate() if a["id"] == failed["id"])
        self.assertFalse(recovered["actionable"])
        self.assertTrue(recovered["observed"]["complete"])
        self.assertNotEqual(failed["observation_id"], recovered["observation_id"])

    def test_incident_identity_excludes_date_and_includes_target(self):
        self.dataset(builds=[build("fail")])
        first = next(a for a in self.evaluate() if a["actionable"])
        self.dataset(builds=[build("fail", generated_at="2026-11-16T13:00:00Z")])
        second = next(a for a in self.evaluate() if a["actionable"])
        self.assertEqual(first["id"], second["id"])
        self.dataset(builds=[build("fail", gfx_target="gfx1201")])
        third = next(a for a in self.evaluate() if a["actionable"])
        self.assertNotEqual(first["id"], third["id"])

    def test_latest_rerun_wins_independent_of_input_order(self):
        a, b = run("failure"), run("success", attempt=2)
        self.dataset([b, a])
        expected = self.evaluate()
        self.assertFalse(any(x["actionable"] for x in expected))
        self.dataset([a, b])
        self.assertEqual(expected, self.evaluate())

    def test_latest_qualification_matrix_does_not_alert_removed_target(self):
        self.dataset(builds=[
            build("fail", run_id="99", gfx_target=None, generated_at="2026-11-16T13:00:00Z"),
            build(),
        ])
        self.assertFalse(any(a["actionable"] for a in self.evaluate()))
        self.assertTrue(all(a["scope"].get("target") == "gfx1151" for a in self.evaluate()))

    def test_failures_warnings_alert_without_recalculating_qualification(self):
        for state in ("fail", "warn"):
            with self.subTest(state=state):
                self.dataset(builds=[build(state, qualified=True, tests={"passed": 1000})])
                active = [a for a in self.evaluate() if a["actionable"]]
                self.assertEqual(len(active), 1)
                self.assertEqual(active[0]["observed"]["status"], state)
                self.assertEqual(active[0]["classification"], "unexplained")

    def test_test_failure_wording_does_not_replace_other_failed_steps(self):
        for step in ("Test", "Tests", "Compile"):
            with self.subTest(step=step):
                self.dataset([run("failure", failed_step=step)])
                active = next(row for row in self.evaluate() if row["actionable"])
                self.assertEqual(active["explanation"], "Some tests in the job have failed."
                                 if step in ("Test", "Tests") else "Job failed: Compile.")
        self.dataset(builds=[build("fail", blocking_tests=["memory check", "load check"])])
        active = next(row for row in self.evaluate() if row["actionable"])
        self.assertEqual(active["explanation"], "Job failed: memory check; load check.")

    def test_upstream_cancelled_is_actionable_even_when_display_state_is_stalled(self):
        self.dataset([run("cancelled", state="stalled")])
        active = [a for a in self.evaluate() if a["actionable"]]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["summary"], "Producer cancelled")
        self.assertEqual(active[0]["observed"]["status"], "cancelled")
        self.assertEqual(active[0]["classification"], "explained_abnormal")
        self.assertEqual(active[0]["explanation"], "Build job cancelled.")

    def test_readiness_recorded_cancellation_does_not_recalculate_qualification_or_duplicate_failure(self):
        for overall in ("unknown", "fail", "pass"):
            with self.subTest(overall=overall):
                self.dataset(builds=[build(overall, build_result="cancelled")])
                active = [a for a in self.evaluate() if a["actionable"]]
                self.assertEqual(len(active), 1)
                self.assertEqual(active[0]["summary"], "Producer cancelled")
                self.assertEqual(active[0]["observed"]["qualification_overall"], overall)
                self.assertEqual(active[0]["observed"]["status"], "cancelled")

    def test_running_result_is_not_cancelled_incident_or_recovery(self):
        self.dataset([run(None, state="running", status="in_progress")])
        self.assertEqual(self.evaluate(), [])

    def test_cancelled_result_recovery_keeps_incident_id(self):
        self.dataset([run("cancelled")])
        cancelled = next(a for a in self.evaluate() if a["actionable"])
        self.dataset([run("success", attempt=2)])
        recovered = next(a for a in self.evaluate() if a["id"] == cancelled["id"])
        self.assertFalse(recovered["actionable"])
        self.assertEqual(recovered["classification"], "expected")
        self.assertTrue(recovered["observed"]["complete"])
        self.assertNotEqual(cancelled["observation_id"], recovered["observation_id"])

    def test_current_nightly_only_is_explicit_policy_not_lifecycle_inference(self):
        self.config["current_nightly_tracks"] = {"nightly": "10.3.0"}
        self.dataset(builds=[build("fail", rocm_version="10.2.0")])
        result = self.evaluate()
        self.assertFalse(any(a["actionable"] for a in result))
        self.assertTrue(all("retained older" in a["explanation"] for a in result))
        self.config.pop("current_nightly_tracks")
        self.assertTrue(any(a["actionable"] for a in self.evaluate()))

    def test_retained_nightly_rule_explains_empty_cells_without_date_or_gpu_duplicates(self):
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        configured = copy.deepcopy(next(rule for rule in config["rules"] if rule["kind"] == "missing"))
        configured["match"] = {"source_id": "nightly", "channel": "nightly"}
        self.config["current_nightly_tracks"] = {"nightly": "10.3.0"}
        self.dataset(builds=[
            build(rocm_version="10.2.0", gfx_target="gfx1151"),
            build(rocm_version="10.2.0", gfx_target="gfx1201"),
        ])
        result = self.evaluate([configured])
        self.assertEqual(len(result), 1)
        policy = result[0]
        self.assertEqual(policy["applies_to"], "missing_observation")
        self.assertFalse(policy["actionable"])
        self.assertEqual(policy["classification"], "expected")
        self.assertNotIn("date", policy["scope"])
        self.assertNotIn("target", policy["scope"])
        self.assertIn("10.3.0", policy["explanation"])
        self.assertIn("10.2.0", policy["explanation"])
        self.assertFalse(policy["observed"]["complete"])
        configured["older_track_response"]["explanation"] = "Monitor {current_track}; retain {track}."
        self.assertEqual(self.evaluate([configured])[0]["explanation"], "Monitor 10.3.0; retain 10.2.0.")
        self.dataset(builds=[build(rocm_version="10.3.0")])
        self.assertFalse(any("applies_to" in row for row in self.evaluate([configured])))
        self.assertEqual(self.evaluate([{**configured, "enabled": False}]), [])

    def test_latest_nightly_versions_and_paused_copy_follow_new_major_minor_and_patch_tracks(self):
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        configured = copy.deepcopy(next(rule for rule in config["rules"] if rule["kind"] == "missing"))
        configured["match"] = {"source_id": "nightly", "channel": "nightly"}
        self.config["current_nightly_tracks"] = {"nightly": "latest"}
        for newest in ("10.4", "10.4.5", "10.10.0", "11.0.0"):
            with self.subTest(newest=newest):
                self.dataset(builds=[
                    build(rocm_version=version, run_id=version)
                    for version in ("10.2.0", "10.3.0", "10.4", newest)
                ])
                result = self.evaluate([configured])
                policy = next(row for row in result if row["scope"]["rocm_version"] == "10.2.0")
                self.assertEqual(policy["summary"], "Monitoring paused")
                self.assertEqual(policy["explanation"], f"Nightly monitoring has moved from ROCm 10.2.0 to ROCm {newest}.")
                self.assertFalse(any(row.get("applies_to") for row in result
                                     if row["scope"]["rocm_version"] == newest))
                self.assertFalse(any(row["actionable"] for row in result))
                self.assertEqual(self.config["current_nightly_tracks"]["nightly"], "latest")

    def test_latest_nightly_prefers_its_published_releases_and_can_select_a_release_without_build_rows(self):
        self.config["current_nightly_tracks"] = {"nightly": "latest"}
        self.dataset(builds=[build(rocm_version="10.2.0"), build(rocm_version="10.10.0")])
        path = self.root / "index.json"
        index = json.loads(path.read_text())
        for version, repository, published in (
            ("10.4.5", "org/repo", "2026-11-17T14:00:00Z"),
            ("10.20.0", "other/repo", "2026-11-17T14:00:00Z"),
            ("10.30.0", "org/repo", "2026-11-18T14:00:00Z"),
        ):
            index["versions"].append({
                "rocm_version": version, "overview": "rocm/overview.json",
                "release": {"channel": "nightly", "repository": repository, "published_at": published},
            })
        _write_json(path, index)
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        configured = copy.deepcopy(next(rule for rule in config["rules"] if rule["kind"] == "missing"))
        configured["match"] = {"source_id": "nightly", "channel": "nightly"}
        policy = next(row for row in self.evaluate([configured]) if row["scope"]["rocm_version"] == "10.2.0")
        self.assertEqual(policy["explanation"], "Nightly monitoring has moved from ROCm 10.2.0 to ROCm 10.4.5.")

    def test_applicability_disabled_rule_and_expiring_exception(self):
        self.dataset([run("failure")])
        self.assertEqual(self.evaluate([rule(match={"platform": "windows"})]), [])
        self.assertEqual(self.evaluate([rule(enabled=False)]), [])
        exempt = rule(exceptions=[{"match": {"job": "base"}, "reason": "accepted maintenance",
                                  "until": "2026-11-17T16:00:00Z"}])
        self.assertFalse(any(a["actionable"] for a in self.evaluate([exempt])))
        self.assertTrue(any(a["actionable"] for a in self.evaluate([exempt], "2026-11-17T16:00:00Z")))

    def test_incomplete_evidence_never_clears_previous_result(self):
        self.dataset([run()], complete=False)
        self.assertEqual(self.evaluate(), [])
        self.dataset([run("failure")], coverage=False)
        active = [a for a in self.evaluate() if a["actionable"]]
        self.assertEqual(len(active), 1)
        self.assertFalse(active[0]["observed"]["complete"])

    def test_future_observations_do_not_recover_failure(self):
        self.dataset([run("failure"), run(run_id="101", created_at="2026-11-18T13:00:00Z")])
        self.assertTrue(any(a["actionable"] for a in self.evaluate()))

    def test_pass_rate_79_80_and_zero(self):
        for successes, failures, expected in ((79, 21, True), (80, 20, False), (0, 0, False)):
            with self.subTest(successes=successes):
                self.dataset([
                    run("success" if i < successes else "failure", run_id=str(i))
                    for i in range(successes + failures)
                ])
                result = self.one("pass_rate")
                self.assertEqual(result["actionable"], expected)
                self.assertEqual(result["observed"]["decided"], successes + failures)
                if successes + failures == 0:
                    self.assertIsNone(result["observed"]["pass_rate_percent"])
                    self.assertEqual(result["classification"], "unexplained")

    def test_pass_rate_exclusions_minimum_window_and_rerun(self):
        self.dataset([
            run("failure", attempt=1), run("success", attempt=2),
            *[run(s, run_id=s) for s in ("skipped", "cancelled", "unknown", None)],
            run("failure", run_id="old", created_at="2026-10-01T13:00:00Z"),
        ])
        result = self.one("pass_rate")
        self.assertEqual(result["observed"]["decided"], 1)
        self.assertEqual(result["observed"]["pass_rate_percent"], 100)
        self.assertEqual(self.one("pass_rate", minimum_samples=2)["classification"], "unexplained")

    def test_pass_rate_incomplete_cannot_prove_threshold_or_recovery(self):
        self.dataset([run("failure")], coverage=False)
        result = self.one("pass_rate")
        self.assertFalse(result["actionable"])
        self.assertFalse(result["observed"]["complete"])
        self.assertEqual(result["classification"], "unexplained")

    def test_pass_rate_recovery_has_same_id(self):
        self.dataset([run("failure")])
        active = self.one("pass_rate")
        self.dataset([run("success", attempt=2)])
        recovered = self.one("pass_rate")
        self.assertTrue(active["actionable"])
        self.assertFalse(recovered["actionable"])
        self.assertEqual(active["id"], recovered["id"])

    def test_missing_schedule_grace_exact_boundary_and_future(self):
        for now, expected in (
            ("2026-11-17T13:59:59Z", False), ("2026-11-17T14:00:00Z", False),
            ("2026-11-17T14:00:01Z", True),
        ):
            with self.subTest(now=now):
                self.dataset(generated=now)
                self.assertEqual(self.evaluate([rule("missing")], now)[0]["actionable"], expected)
        self.dataset([run(created_at="2026-11-18T13:00:00Z")])
        self.assertTrue(self.one("missing")["actionable"])

    def test_not_yet_due_current_day_uses_previous_satisfied_occurrence(self):
        self.dataset([run(created_at="2026-11-16T13:00:00Z")])
        result = self.evaluate([rule("missing")], "2026-11-17T11:00:00Z")[0]
        self.assertFalse(result["actionable"])
        self.assertEqual(result["expected"]["due_at"], "2026-11-16T13:00:00+00:00")

    def test_weekly_unsloth_has_no_daily_gap(self):
        self.dataset([run(created_at="2026-11-10T13:00:00Z")])
        weekly = rule("missing", schedule={"timezone": "UTC", "weekdays": [1], "time": "13:00"})
        self.assertFalse(self.evaluate([weekly], "2026-11-16T15:00:00Z")[0]["actionable"])
        self.assertTrue(self.evaluate([weekly])[0]["actionable"])

    def test_weekday_weekend_and_timezone_are_explicit(self):
        self.dataset([run(created_at="2026-11-13T13:00:00Z")], generated="2026-11-15T15:00:00Z")
        weekday = rule("missing", schedule={"timezone": "UTC", "weekdays": [0, 1, 2, 3, 4], "time": "13:00"})
        self.assertFalse(self.evaluate([weekday], "2026-11-15T15:00:00Z")[0]["actionable"])
        self.assertTrue(self.evaluate([rule("missing")], "2026-11-15T15:00:00Z")[0]["actionable"])
        eastern = rule("missing", schedule={"timezone": "America/New_York", "weekdays": [1], "time": "09:00"})
        self.dataset(generated="2026-11-17T14:30:00Z")
        result = self.evaluate([eastern], "2026-11-17T14:30:00Z")[0]
        self.assertFalse(result["actionable"])
        self.assertEqual(result["expected"]["deadline"], "2026-11-17T15:00:00+00:00")

    def test_change_triggered_absence_needs_verified_eligible_event(self):
        self.dataset()
        event_rule = rule("missing", event_driven=True)
        event_rule.pop("schedule")
        self.assertFalse(self.evaluate([event_rule])[0]["actionable"])
        eligible = {"verified": True, "eligible": True, "at": "2026-11-17T13:00:00Z",
                    "url": "https://github.com/org/repo/commit/abc"}
        self.dataset([run(created_at="2026-11-16T13:00:00Z", eligible_event=eligible)])
        self.assertTrue(self.evaluate([event_rule])[0]["actionable"])
        eligible["verified"] = False
        self.dataset([run(created_at="2026-11-16T13:00:00Z", eligible_event=eligible)])
        self.assertFalse(self.evaluate([event_rule])[0]["actionable"])

    def test_collection_since_must_cover_pass_rate_window(self):
        self.dataset([run("failure")])
        import json
        path = self.root / "upstream/overview.json"
        overview = json.loads(path.read_text())
        overview["projects"][0]["coverage"]["since"] = "2026-11-16T00:00:00Z"
        _write_json(path, overview)
        result = self.one("pass_rate")
        self.assertFalse(result["actionable"])
        self.assertFalse(result["observed"]["complete"])

    def test_failed_empty_source_does_not_create_service_incident(self):
        self.dataset()
        import json
        path = self.root / "index.json"
        index = json.loads(path.read_text())
        index["sources"][0]["status"] = "error"
        _write_json(path, index)
        self.assertFalse(any(a["actionable"] for a in self.evaluate()))

    def test_incomplete_collection_never_proves_missed_producer(self):
        self.dataset(coverage=False)
        result = self.one("missing")
        self.assertFalse(result["actionable"])
        self.assertEqual(result["classification"], "unexplained")
        self.assertIn("cannot prove", result["explanation"])

    def test_old_snapshot_before_due_cannot_prove_missed_run(self):
        self.dataset(generated="2026-11-17T11:00:00Z")
        result = self.one("missing")
        self.assertFalse(result["actionable"])
        self.assertFalse(result["observed"]["complete"])
        self.assertIn("predates", result["explanation"])

    def test_stopped_nightly_feed_uses_policy_not_invented_schedule(self):
        self.dataset(builds=[build(generated_at="2026-11-14T13:00:00Z")])
        missing = rule("missing", match={"source_id": "nightly"}, max_age_hours=48)
        missing.pop("schedule")
        result = self.evaluate([missing])[0]
        self.assertTrue(result["actionable"])
        self.assertEqual(result["expected"]["deadline"], "2026-11-16T14:00:00+00:00")

    def test_future_publication_cannot_prove_result_recovery(self):
        self.dataset([run()], generated="2026-11-18T10:00:00Z")
        self.assertEqual(self.evaluate(), [])

    def test_partial_source_collection_does_not_create_service_incident(self):
        self.dataset(coverage=False)
        result = self.evaluate([rule("missing")])
        self.assertFalse(any(a["actionable"] for a in result))
        self.assertTrue(all(not a["observed"]["complete"] for a in result))

    def test_pass_proves_recovery_from_unexplained_skip(self):
        self.dataset([run("skipped")])
        skipped = next(a for a in self.evaluate() if a["actionable"])
        self.dataset([run("success", attempt=2)])
        recovered = next(a for a in self.evaluate() if a["id"] == skipped["id"])
        self.assertFalse(recovered["actionable"])
        self.assertEqual(recovered["classification"], "expected")
        self.assertTrue(recovered["observed"]["complete"])

    def test_unverified_condition_is_not_fabricated_runner_explanation(self):
        self.dataset([run("skipped")])
        result = next(a for a in self.evaluate() if a["actionable"])
        self.assertEqual(result["classification"], "unexplained")
        self.assertNotIn("unavailable hardware", result["explanation"])

    def test_verified_permitted_condition_skip_is_expected(self):
        self.dataset([run("skipped", verified_skip={
            "verified": True, "permitted": True, "reason": "Evaluated gate was false.",
            "workflow_url": "https://github.com/org/repo/blob/abc/workflow.yml",
            "event_url": "https://github.com/org/repo/actions/runs/100",
        })])
        result = self.evaluate()
        self.assertFalse(any(a["actionable"] for a in result))
        self.assertEqual(result[0]["classification"], "expected")
        self.assertEqual(len(result[0]["evidence"]), 3)

    def test_causal_skip_correlates_only_verified_same_run_prerequisite(self):
        jobs = [
            {"id": "base", "workflow": "build.yml", "os": "linux"},
            {"id": "studio", "workflow": "build.yml", "os": "linux"},
        ]
        skipped = run("skipped", job="studio", verified_dependencies={
            "verified": True, "jobs": ["base"],
            "workflow_url": "https://github.com/org/repo/blob/abc/build.yml",
        })
        self.dataset([run("failure"), skipped], jobs=jobs)
        result = self.evaluate()
        active = [a for a in result if a["actionable"]]
        correlated = next(a for a in result if a["summary"] == "Dependency skip")
        self.assertEqual(len(active), 1)
        self.assertEqual(correlated["causal_incident_id"], active[0]["id"])
        self.assertEqual(correlated["classification"], "explained_abnormal")
        self.dataset([run("failure", run_id="99"), skipped], jobs=jobs)
        self.assertEqual(sum(a["actionable"] for a in self.evaluate()), 2)

    def test_dataset_paths_cannot_escape_root(self):
        self.dataset()
        _write_json(self.root / "rocm/overview.json", {"history": [{"path": "../sources.json"}]})
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.evaluate()

    def test_config_validation_and_repository_defaults(self):
        import json
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        self.assertEqual(assessments.validate_config(config), config)
        for bad in (
            {"schema_version": 1, "rules": [], "current_nightly_tracks": {"nightly": "not-a-version"}},
            {"schema_version": 1, "rules": [rule("missing", older_track_response={
                "summary": "Retained", "explanation": "{recipient}",
            })]},
            {"schema_version": 1, "rules": [], "incident_labels": {"source": "\ninvalid"}},
            {"schema_version": 1, "rules": [], "incident_labels": {"source": ["engine:llamacpp"]}},
            {"schema_version": 2, "rules": []},
            {"schema_version": 1, "rules": [rule(), rule()]},
            {"schema_version": 1, "rules": [rule("pass_rate", threshold_percent=101)]},
            {"schema_version": 1, "rules": [rule("pass_rate", minimum_samples=0)]},
            {"schema_version": 1, "rules": [rule(match={"recipient": "private"})]},
            {"schema_version": 1, "rules": [rule("missing", max_age_hours=float("nan"))]},
            {"schema_version": 1, "rules": [rule("collector", max_age_hours=30)]},
            {"schema_version": 1, "rules": [rule("missing", schedule={"timezone": "UTC", "weekdays": [7], "time": "13:00"})]},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                assessments.validate_config(bad)

    def test_shipped_rules_do_not_alert_on_our_dataset_age(self):
        import json
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        self.dataset([run()], generated="2026-11-17T15:00:00Z")
        for now in ("2026-11-17T15:00:00Z", "2026-11-19T15:00:00Z"):
            with self.subTest(now=now):
                result = assessments.evaluate_dataset(self.root, config, now)
                self.assertFalse(any(a["actionable"] for a in result))
                self.assertTrue(all(a["scope"].get("source_id") != "collector" for a in result))

    def test_upstream_failure_still_alerts_without_collector_monitoring(self):
        import json
        config = json.loads((Path(__file__).parents[1] / "alert-rules.json").read_text())
        self.dataset([run("failure", failed_step="Compile")])
        result = assessments.evaluate_dataset(self.root, config, NOW)
        active = [a for a in result if a["actionable"]]
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["summary"], "Job failed: Compile.")
        self.assertEqual(active[0]["scope"]["source_id"], "test-upstream")
        self.assertIn("Compile", active[0]["explanation"])

    def test_newer_failed_live_sync_overrides_good_index_and_blocks_recovery(self):
        self.dataset([run()], generated="2026-11-17T14:00:00Z")
        failed_sync = {
            "attempted_at": "2026-11-17T14:30:00Z", "status": "failed",
            "last_successful_at": "2026-11-17T14:00:00Z",
            "errors": [{"source_id": "pipeline", "record": "private/internal/path",
                        "field": "publication", "reason": "Push rejected"}],
        }
        _write_json(self.root / "sync.json", {"schema_version": 1, "sync": failed_sync})
        self.assertEqual(self.evaluate(), [])
        successful_sync = {
            "attempted_at": "2026-11-17T14:45:00Z", "status": "success",
            "last_successful_at": "2026-11-17T14:45:00Z", "errors": [],
        }
        _write_json(self.root / "sync.json", {"schema_version": 1, "sync": successful_sync})
        result = self.evaluate()
        self.assertTrue(result)
        self.assertTrue(all(not a["actionable"] and a["observed"]["complete"] for a in result))

    def test_latest_pointer_newer_failure_wins_over_stale_successful_sync(self):
        self.dataset([run()], generated="2026-11-17T14:00:00Z")
        _write_json(self.root / "sync.json", {"schema_version": 1, "sync": {
            "attempted_at": "2026-11-17T14:00:00Z", "status": "success", "errors": [],
        }})
        _write_json(self.root / "latest.json", {"schema_version": 1, "sync": {
            "attempted_at": "2026-11-17T14:30:00Z", "status": "failed", "errors": [],
        }})
        self.assertEqual(self.evaluate(), [])

    def test_missing_dataset_reports_evaluation_error_not_service_incident(self):
        _write_json(self.root / "sync.json", {"schema_version": 1, "sync": {
            "attempted_at": "2026-11-17T14:30:00Z", "status": "failed",
            "last_successful_at": None, "errors": [],
        }})
        with self.assertRaises(FileNotFoundError):
            self.evaluate()

    def test_older_failed_sync_does_not_override_newer_good_index(self):
        self.dataset()
        _write_json(self.root / "sync.json", {"schema_version": 1, "sync": {
            "attempted_at": "2026-11-16T14:30:00Z", "status": "failed", "errors": [],
        }})
        self.assertFalse(any(a["actionable"] for a in self.evaluate()))


if __name__ == "__main__":
    unittest.main()

import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.diagnosis import prepare_assessments, diagnosis_artifact, import_results


def assessment(**extra):
    return {"id": "incident", "observation_id": "observation", "actionable": True,
            "classification": "explained_abnormal", "explanation": "Some tests in the job have failed.",
            "explanation_basis": "failed_step", "observed": {"status": "fail"}, **extra}


class Collector:
    def collect(self, row):
        self.evidence = [{"id": "E1", "text": "Compiler exhausted memory", "url": "https://github.com/o/r/actions/runs/1"}]
        return {"evidence": self.evidence}

    def call_tool(self, name, args):
        return {"evidence": self.evidence}


class Client:
    def __init__(self):
        self.calls = 0

    def diagnose(self, package, tools):
        self.calls += 1
        return {"method": "model", "certainty": "likely", "cause": "The compiler ran out of memory.", "evidence_ids": ["E1"]}


class DiagnosisTests(unittest.TestCase):
    def test_temporary_model_failure_is_retried_for_unchanged_evidence(self):
        class Temporary(Client):
            def diagnose(self, package, tools):
                self.calls += 1
                return {"method": "model", "certainty": "unknown", "code": "analysis_unavailable"}
        client = Temporary()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            for _ in range(2):
                result = prepare_assessments([assessment()], enabled=True, collector=Collector(), client=client, cache_path=path)[0]
                self.assertTrue(result["escalation_required"])
            self.assertEqual(client.calls, 2)
            self.assertEqual(json.loads(path.read_text())["results"], {})

    def test_rules_precede_model_without_changing_verdict(self):
        original = assessment(explanation_basis="configured")
        client = Client()
        result = prepare_assessments([original], enabled=True, collector=Collector(), client=client)[0]
        self.assertEqual(client.calls, 0)
        self.assertFalse(result["escalation_required"])
        self.assertTrue(result["actionable"])
        self.assertEqual(result["observed"], {"status": "fail"})
        self.assertNotIn("escalation_required", original)

    def test_failed_step_needs_diagnosis_unknown_disabled_escalates(self):
        result = prepare_assessments([assessment()])[0]
        self.assertTrue(result["escalation_required"])
        self.assertEqual(result["diagnosis"]["certainty"], "unknown")

    def test_supported_model_cause_prevents_escalation_and_is_cached(self):
        client = Client()
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache.json"
            for _ in range(2):
                result = prepare_assessments([assessment()], enabled=True, collector=Collector(), client=client, cache_path=cache)[0]
                self.assertFalse(result["escalation_required"])
                self.assertEqual(result["explanation"], "Likely: The compiler ran out of memory.")
            self.assertEqual(client.calls, 1)
            prepare_assessments([assessment(observation_id="rerun")], enabled=True, collector=Collector(), client=client, cache_path=cache)
            self.assertEqual(client.calls, 2)
            self.assertNotIn("Compiler exhausted memory", cache.read_text())

    def test_changed_tool_evidence_invalidates_cached_cause(self):
        class ToolCollector(Collector):
            def __init__(self, detail):
                self.detail = detail

            def call_tool(self, name, args):
                self.evidence.append({"id": "E2", "text": self.detail, "url": "https://github.com/o/r/actions/runs/1"})
                return {"evidence": self.evidence[-1:]}

        class ToolClient(Client):
            def diagnose(self, package, tools):
                self.calls += 1
                tools["search_job_log"](query="error")
                return {"method": "model", "certainty": "likely", "cause": "The compiler ran out of memory.", "evidence_ids": ["E2"]}

        client = ToolClient()
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "cache.json"
            for detail in ("old error", "old error", "changed error"):
                prepare_assessments([assessment()], enabled=True, collector=ToolCollector(detail), client=client, cache_path=cache)
            self.assertEqual(client.calls, 2)

    def test_invalid_citation_escalates(self):
        class Invalid(Client):
            def diagnose(self, package, tools):
                return {"method": "model", "certainty": "likely", "cause": "Out of memory", "evidence_ids": ["invented"]}
        result = prepare_assessments([assessment()], enabled=True, collector=Collector(), client=Invalid())[0]
        self.assertTrue(result["escalation_required"])
        self.assertEqual(result["explanation"], assessment()["explanation"])

    def test_import_rejects_stale_inputs_changed_evidence_and_verified_claims(self):
        rows = [assessment()]
        artifact = diagnosis_artifact(rows, prepare_assessments(rows, enabled=True, collector=Collector(), client=Client()))
        self.assertFalse(import_results(rows, artifact, collector=Collector())[0]["escalation_required"])
        self.assertTrue(import_results([assessment(observation_id="rerun")], artifact, collector=Collector())[0]["escalation_required"])
        class Changed(Collector):
            def collect(self, row):
                value = super().collect(row)
                self.evidence[0]["text"] = "different failure"
                return value
        self.assertTrue(import_results(rows, artifact, collector=Changed())[0]["escalation_required"])
        forged = copy.deepcopy(artifact)
        forged["results"][0]["diagnosis"].update(method="deterministic", certainty="verified")
        self.assertTrue(import_results(rows, forged, collector=Collector())[0]["escalation_required"])

    def test_unknown_result_cache_survives_artifact_publication(self):
        class Unknown(Client):
            def diagnose(self, package, tools):
                self.calls += 1
                return {"method": "model", "certainty": "unknown", "code": "insufficient_evidence"}
        rows = [assessment()]
        client = Unknown()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cache.json"
            prepared = prepare_assessments(rows, enabled=True, collector=Collector(), client=client)
            artifact = diagnosis_artifact(rows, prepared)
            imported = import_results(rows, artifact, collector=Collector(), cache_path=path)
            self.assertTrue(imported[0]["escalation_required"])
            prepare_assessments(rows, enabled=True, collector=Collector(), client=client, cache_path=path)
            self.assertEqual(client.calls, 1)

    def test_malformed_artifact_method_and_keyless_unknown_do_not_fetch(self):
        class NoFetch(Collector):
            def collect(self, row):
                self.fail_if_called = True
                raise AssertionError("malformed artifact fetched evidence")

        rows = [assessment()]
        for diagnosis in ({"method": [], "certainty": "likely"},
                          {"certainty": "unknown", "code": "unavailable"}):
            artifact = diagnosis_artifact(rows, [{"diagnosis": diagnosis}])
            result = import_results(rows, artifact, collector=NoFetch())
            self.assertTrue(result[0]["escalation_required"])

    def test_artifact_verification_has_one_collective_deadline(self):
        rows = [assessment(), assessment(id="second")]
        prepared = prepare_assessments(rows, enabled=True, collector=Collector(), client=Client())
        artifact = diagnosis_artifact(rows, prepared)
        elapsed = [0]
        class Slow(Collector):
            def __init__(self):
                self.calls = 0
            def collect(self, row):
                self.calls += 1
                elapsed[0] += 121
                return super().collect(row)
        collector = Slow()
        result = import_results(rows, artifact, collector=collector, clock=lambda: elapsed[0])
        self.assertEqual(collector.calls, 1)
        self.assertTrue(all(row["escalation_required"] for row in result))
        self.assertEqual(collector.deadline, 120)

    def test_analysis_failure_preserves_incident(self):
        class Broken(Collector):
            def collect(self, row):
                raise OSError("private details")
        result = prepare_assessments([assessment()], enabled=True, collector=Broken(), client=Client())[0]
        self.assertTrue(result["escalation_required"])
        self.assertNotIn("private", json.dumps(result))


if __name__ == "__main__":
    unittest.main()

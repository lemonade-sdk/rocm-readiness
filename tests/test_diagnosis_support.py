import copy
import json
import unittest

from scripts.diagnosis_support import validate_support, workflow_jobs, supported_skip_cause


class SupportTests(unittest.TestCase):
    def setUp(self):
        self.incident = {
            'observed': {'status': 'skip'},
            'scope': {'repository': 'org/repo', 'job': 'build'},
            'provenance': {'run_id': 10, 'attempt': 2, 'job_id': 20,
                           'revision': 'abc123', 'workflow': '.github/workflows/ci.yml'},
        }
        self.result = {'certainty': 'likely', 'cause': 'A required job failed, so this job was skipped.',
                       'evidence_ids': ['E1', 'E2']}
        self.packet = {'run_id': 10, 'attempt': 2, 'jobs': [
            {'id': 19, 'name': 'approval', 'conclusion': 'failure'},
            {'id': 20, 'name': 'build', 'conclusion': 'skipped'}]}
        self.workflow = 'jobs:\n  approval:\n    runs-on: ubuntu-latest\n  build:\n    needs: approval\n    steps:\n    - run: echo hello\n      env:\n        TOKEN: ${{ secrets.TOKEN }}\n'

    def evidence(self):
        return [
            {'id': 'E1', 'kind': 'jobs', 'url': 'https://github.com/org/repo/actions/runs/10/attempts/2', 'text': json.dumps(self.packet)},
            {'id': 'E2', 'kind': 'workflow', 'workflow_complete': True, 'url': 'https://github.com/org/repo/blob/abc123/.github/workflows/ci.yml', 'text': self.workflow},
        ]

    def check(self):
        return validate_support(self.result, self.evidence(), self.incident)

    def test_dependency_and_unrelated_step_secret(self):
        self.assertTrue(self.check())

    def test_missing_or_uncited_workflow(self):
        self.result['evidence_ids'] = ['E1']
        self.assertFalse(self.check())
        self.assertFalse(validate_support(self.result, self.evidence()[:1], self.incident))

    def test_wrong_attempt_and_run(self):
        for key, value in [('attempt', 1), ('run_id', 11)]:
            with self.subTest(key=key):
                original = self.packet[key]
                self.packet[key] = value
                self.assertFalse(self.check())
                self.packet[key] = original
        self.packet['jobs'][0]['run_attempt'] = 1
        self.assertFalse(self.check())

    def test_wrong_revision_or_repository(self):
        for field in ('revision', 'repository'):
            evidence = self.evidence()
            evidence[1]['url'] = evidence[1]['url'].replace('abc123' if field == 'revision' else 'org/repo', 'wrong')
            self.assertFalse(validate_support(self.result, evidence, self.incident))

    def test_unrelated_failure(self):
        self.packet['jobs'][0]['name'] = 'unrelated'
        self.assertFalse(self.check())

    def test_workflow_alone_not_observation(self):
        self.packet['jobs'][0]['conclusion'] = 'success'
        self.assertFalse(self.check())

    def test_explicit_success_or_skipped_gate(self):
        self.workflow = self.workflow.replace('    needs: approval', "    needs: approval\n    if: github.repository_owner == 'org' && always() && (needs.approval.result == 'success' || needs.approval.result == 'skipped')")
        self.assertTrue(self.check())

    def test_always_or_failure_condition_not_proof(self):
        for condition in ('always()', "needs.approval.result == 'failure'", "needs.approval.result == 'success' || always()"):
            self.workflow = 'jobs:\n  approval:\n    runs-on: ubuntu-latest\n  build:\n    needs: approval\n    if: ' + condition + '\n'
            self.assertFalse(self.check())

    def test_hidden_gate_never_reconstructed(self):
        self.workflow = self.workflow.replace('    needs: approval', "    needs: approval\n    if: vars.ENABLED == 'true'")
        self.result['cause'] = 'ENABLED was false so build did not run.'
        self.assertFalse(self.check())
        self.result['cause'] = 'approval failed, so build did not run.'
        self.assertFalse(self.check())

    def test_ambiguous_duplicate_and_matrix_names(self):
        self.packet['jobs'].append(copy.deepcopy(self.packet['jobs'][0]))
        self.assertFalse(self.check())
        self.assertIsNone(workflow_jobs(self.workflow + '  build:\n    needs: approval\n'))

    def test_list_needs_and_display_name(self):
        self.workflow = self.workflow.replace('    needs: approval', '    name: build\n    needs: [approval]')
        self.assertTrue(self.check())
        self.workflow = self.workflow.replace('needs: [approval]', 'needs:\n      - approval')
        self.assertTrue(self.check())

    def test_explicit_truncation_and_conflicting_snippets(self):
        evidence = self.evidence()
        evidence[1]['workflow_complete'] = False
        self.assertFalse(validate_support(self.result, evidence, self.incident))
        evidence = self.evidence()
        duplicate = dict(evidence[1], id='E3', text=self.workflow.replace('needs: approval', 'needs: unrelated'))
        self.result['evidence_ids'].append('E3')
        self.assertFalse(validate_support(self.result, evidence + [duplicate], self.incident))

    def test_prerequisite_name_alone_not_causal_assertion(self):
        for cause in ('approval succeeded, so build did not run.',
                      'approval was not failed, so build did not run.',
                      'approval did not fail, so build did not run.',
                      'approval was present; some other issue blocked build.'):
            self.result['cause'] = cause
            self.assertFalse(self.check(), cause)

    def test_outcome_assertion_must_match_observation(self):
        self.packet['jobs'][0]['conclusion'] = 'cancelled'
        self.assertFalse(self.check())
        self.result['cause'] = 'A required job was cancelled, so this job was skipped.'
        self.assertTrue(self.check())

    def test_model_validator_uses_provenance_and_complete_metadata(self):
        from scripts.diagnosis_model import validate_result
        from scripts.diagnosis import supported_result
        result = dict(self.result, method='model')
        for validator in (validate_result, supported_result):
            self.assertTrue(validator(result, self.evidence(), self.incident))
            missing = self.evidence()
            del missing[1]['workflow_complete']
            self.assertFalse(validator(result, missing, self.incident))
            wrong = dict(self.incident['provenance'], attempt=3)
            self.assertFalse(validator(result, self.evidence(), self.incident, wrong))

    def test_untrusted_prose_is_never_accepted_as_proof(self):
        for cause in ('There was no failure of approval; build was skipped for another reason.',
                      'approval failed, but that did not prevent this build from running.'):
            self.result['cause'] = cause
            self.assertFalse(self.check())
        self.assertEqual(supported_skip_cause(self.evidence(), self.incident),
                         'A required job failed, so this job was skipped.')

    def test_prerequisite_continue_on_error_and_inheritance(self):
        original = self.workflow
        for setting in ('true', "${{ matrix.experimental }}", "'false'"):
            self.workflow = original.replace('  approval:\n', '  approval:\n    continue-on-error: ' + setting + '\n')
            self.assertIsNone(supported_skip_cause(self.evidence(), self.incident))
        self.workflow = original.replace('  approval:\n', '  approval:\n    continue-on-error: false\n')
        self.assertTrue(self.check())
        self.workflow = original.replace('  approval:\n', '  approval:\n    <<: *defaults\n')
        self.assertIsNone(supported_skip_cause(self.evidence(), self.incident))

    def test_client_normalizes_only_from_cited_dependency_proof(self):
        from scripts.diagnosis_model import LemonadeClient
        raw = {"certainty": "likely", "cause": "approval failed, but that did not prevent this build from running.",
               "evidence_ids": ["E1", "E2"]}
        def request(*args):
            return {"choices": [{"message": {"content": json.dumps(raw)}}]}
        package = {"incident": self.incident, "evidence": self.evidence()}
        result = LemonadeClient(request=request).diagnose(package)
        self.assertEqual(result["cause"], "A required job failed, so this job was skipped.")
        raw["evidence_ids"] = ["E1"]
        self.assertEqual(LemonadeClient(request=request).diagnose(package)["certainty"], "unknown")

    def test_other_status_outside_skip_guard(self):
        self.incident['observed']['status'] = 'fail'
        self.assertTrue(validate_support(self.result, [], self.incident))


if __name__ == '__main__':
    unittest.main()

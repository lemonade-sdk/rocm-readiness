"""Shell regression tests with real preparation/collection and offline GitHub fixtures."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40


class RunDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'data').mkdir()
        for name in ('run-diagnosis.sh', 'diagnosis.py', 'diagnosis_model.py',
                     'diagnosis_support.py', 'notifications.py'):
            shutil.copyfile(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        shutil.copyfile(ROOT / 'scripts/diagnosis_evidence.py', self.root / 'scripts/_real_evidence.py')
        (self.root / 'scripts/__init__.py').write_text('')
        (self.root / 'scripts/assessments.py').write_text('''import json
from pathlib import Path
def validate_config(value): return value
def evaluate_dataset(dataset, rules, now):
    return json.loads(Path('fixture.json').read_text())['rows']
''')
        (self.root / 'scripts/diagnosis_evidence.py').write_text('''import json
from pathlib import Path
from ._real_evidence import EvidenceCollector as RealCollector, redact
class EvidenceCollector(RealCollector):
    def __init__(self, repositories, token=None):
        self.fixture = json.loads(Path('fixture.json').read_text())['responses']
        super().__init__(repositories, token=token, request=self.request_fixture)
    def request_fixture(self, url, headers, limit):
        with Path('collection-calls.txt').open('a') as stream:
            stream.write(url + '\\n')
        key = url.removeprefix('https://api.github.com')
        if key not in self.fixture: return 404, {}, b''
        value = self.fixture[key]
        body = value['raw'].encode() if 'raw' in value else json.dumps(value).encode()
        return 200, {}, body
''')
        (self.root / 'alert-rules.json').write_text('{}')
        (self.root / 'sources.json').write_text(json.dumps({'sources': [{'repository': 'org/project'}]}))
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.output = self.root / 'result.json'
        self.fixture = {'rows': [], 'responses': {
            '/repos/org/project': {'private': False, 'visibility': 'public'},
            '/repos/org/project/contents/.github/workflows/ci.yml?ref=' + SHA: {
                'encoding': 'base64', 'content': base64.b64encode(b'jobs: {}').decode()},
        }}

    def add_case(self, number, known):
        run, job = 10 + number, 20 + number
        self.fixture['rows'].append({
            'id': 'incident-' + str(number), 'observation_id': str(run) + '-2-' + str(job),
            'actionable': True, 'classification': 'unexplained',
            'scope': {'repository': 'org/project'}, 'observed': {'status': 'fail'},
            'provenance': {'run_id': run, 'attempt': 2, 'job_id': job, 'revision': SHA},
            'evidence': [],
        })
        self.fixture['responses'].update({
            f'/repos/org/project/actions/runs/{run}': {'id': run, 'path': '.github/workflows/ci.yml'},
            f'/repos/org/project/actions/runs/{run}/attempts/2': {
                'id': run, 'run_attempt': 2, 'head_sha': SHA, 'path': '.github/workflows/ci.yml'},
            f'/repos/org/project/actions/runs/{run}/attempts/2/jobs?per_page=100': {
                'total_count': 1, 'jobs': [{'id': job, 'run_id': run, 'run_attempt': 2, 'conclusion': 'failure'}]},
            f'/repos/org/project/actions/jobs/{job}/logs': {'raw': (
                'lld-link: error: unable to find mt.exe in PATH: no such file or directory\n'
                if known else 'some unexplained runtime failure\n')},
        })

    def run_script(self, binary):
        (self.root / 'fixture.json').write_text(json.dumps(self.fixture))
        environment = dict(os.environ, LEMONADE_BINARY=str(binary))
        environment.pop('ROCM_READINESS_MODEL_CACHE', None)
        result = subprocess.run(['bash', 'scripts/run-diagnosis.sh', str(self.output)],
                                cwd=self.root, env=environment, capture_output=True,
                                text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result, json.loads(self.output.read_text())

    def test_known_source_rule_never_checks_missing_binary(self):
        self.add_case(1, known=True)
        result, artifact = self.run_script(self.root / 'missing-lemond')
        self.assertNotIn('missing-lemond', result.stderr)
        self.assertEqual(artifact['results'][0]['diagnosis']['method'], 'deterministic')
        self.assertEqual(artifact['results'][0]['diagnosis']['certainty'], 'verified')
        cache = json.loads((self.root / 'data/diagnosis-cache.json').read_text())
        self.assertEqual(len(cache['results']), 1)
        self.assertTrue((self.root / 'collection-calls.txt').exists())

    def test_mixed_dataset_bad_binary_retains_verified_artifact(self):
        self.add_case(1, known=True)
        self.add_case(2, known=False)
        binary = self.root / 'bad-lemond'
        binary.write_text('#!/bin/sh\necho called > binary-called.txt\nexit 1\n')
        binary.chmod(0o755)
        result, artifact = self.run_script(binary)
        self.assertTrue((self.root / 'binary-called.txt').exists())
        self.assertIn('retained rules and verified source explanations', result.stderr)
        diagnoses = [row['diagnosis'] for row in artifact['results']]
        self.assertEqual(diagnoses[0]['certainty'], 'verified')
        self.assertEqual(diagnoses[1], {'certainty': 'unknown', 'code': 'model_required'})
        self.assertFalse(list(self.root.glob('result.json.model.*')))
        cache = json.loads((self.root / 'data/diagnosis-cache.json').read_text())
        self.assertEqual(len(cache['results']), 1)

    def test_unknown_with_missing_binary_remains_unknown(self):
        self.add_case(1, known=False)
        _, artifact = self.run_script(self.root / 'missing-lemond')
        self.assertEqual(artifact['results'][0]['diagnosis'],
                         {'certainty': 'unknown', 'code': 'model_required'})

    def test_cancelled_only_never_checks_missing_binary(self):
        for spelling in ('cancelled', 'canceled'):
            self.fixture['rows'] = []
            self.add_case(1, known=False)
            self.fixture['rows'][0]['observed']['status'] = spelling
            result, artifact = self.run_script(self.root / 'missing-lemond')
            self.assertNotIn('missing-lemond', result.stderr)
            self.assertEqual(artifact['results'][0]['diagnosis'],
                             {'certainty': 'unknown', 'code': 'cancellation_reason_unavailable'})

    def test_configured_rule_requires_no_evidence_or_binary(self):
        self.fixture['rows'] = [{'id': 'configured', 'actionable': True,
                                 'explanation_basis': 'configured'}]
        result, artifact = self.run_script(self.root / 'missing-lemond')
        self.assertNotIn('missing-lemond', result.stderr)
        self.assertEqual(artifact['results'][0]['diagnosis'], {})
        self.assertFalse((self.root / 'collection-calls.txt').exists())


if __name__ == '__main__':
    unittest.main()

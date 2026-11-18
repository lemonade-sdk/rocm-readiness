import base64
from http.client import IncompleteRead
import json
import unittest
from unittest.mock import MagicMock, patch

from scripts.diagnosis_evidence import EvidenceCollector, EvidenceUnavailable, MAX_DOCUMENT_BYTES, redact

REPO = 'org/project'
SHA = 'a' * 40


class EvidenceTests(unittest.TestCase):
    def test_protocol_failure_becomes_unavailable_evidence(self):
        collector = EvidenceCollector([REPO])
        response = MagicMock()
        response.read1.side_effect = IncompleteRead(b"partial")
        with patch('scripts.diagnosis_evidence.build_opener') as opener:
            opener.return_value.open.return_value = response
            with self.assertRaises(EvidenceUnavailable):
                collector._request('https://api.github.com/repos/org/project', {}, 100)

    def test_streaming_deadline_is_checked_between_single_reads(self):
        collector = EvidenceCollector([REPO])
        collector.started = 0
        collector.deadline = 1
        response = MagicMock()
        response.read1.return_value = b"x"
        with patch('scripts.diagnosis_evidence.build_opener') as opener, patch('scripts.diagnosis_evidence.monotonic', side_effect=[0, 0, 2]):
            opener.return_value.open.return_value = response
            with self.assertRaises(EvidenceUnavailable):
                collector._request('https://api.github.com/repos/org/project', {}, 100)
        self.assertEqual(response.read1.call_count, 1)

    def setUp(self):
        self.calls = []
        self.data = {
            '/repos/org/project': {'private': False, 'visibility': 'public'},
            '/repos/org/project/actions/runs/11': {'id': 11, 'path': '.github/workflows/test.yml'},
            '/repos/org/project/actions/runs/11/attempts/2': {'id': 11, 'run_attempt': 2, 'head_sha': SHA, 'path': '.github/workflows/test.yml'},
            '/repos/org/project/actions/runs/11/attempts/2/jobs?per_page=100': {'total_count': 1, 'jobs': [{'id': 22, 'run_id': 11, 'run_attempt': 2, 'conclusion': 'failure'}]},
            '/repos/org/project/contents/.github/workflows/test.yml?ref=' + SHA: {'encoding': 'base64', 'content': base64.b64encode(b'name: test\njobs: {}').decode()},
        }
        self.redirect = 'https://productionresultssa1.blob.core.windows.net/logs/file?sig=SECRET'
        self.body = b'test failure\ntoken=CANARY\ncontact person@example.com\n'
        self.assessment = {'scope': {'repository': REPO}, 'provenance': {'run_id': 11, 'attempt': 2, 'job_id': 22, 'revision': SHA}, 'evidence': []}

    def request(self, url, headers, limit):
        self.calls.append((url, headers))
        if url.endswith('/actions/jobs/22/logs'):
            return 302, {'Location': self.redirect}, b''
        if url == self.redirect:
            return 200, {}, self.body
        key = url.removeprefix('https://api.github.com')
        if key not in self.data:
            return 404, {}, b''
        return 200, {}, json.dumps(self.data[key]).encode()

    def collector(self):
        return EvidenceCollector([REPO], token='TOKEN_SECRET', request=self.request, secrets=['CANARY'])

    def test_basic_and_proxy_authorization_payloads_are_redacted(self):
        value = redact('Authorization: Basic CANARYBASE64\nProxy-Authorization: Bearer PROXYCANARY\n')
        self.assertNotIn('CANARYBASE64', value)
        self.assertNotIn('PROXYCANARY', value)

    def test_missing_build_never_diagnoses_a_previous_builds_log(self):
        self.assessment['anomaly'] = 'missing_evidence'
        self.assessment['evidence'] = [{'label': 'Job', 'url': f'https://github.com/{REPO}/actions/runs/11/job/22'}]
        result = self.collector().collect(self.assessment)
        self.assertEqual(result['evidence'], [])
        self.assertEqual(result['code'], 'missing_interval_evidence_unavailable')
        self.assertEqual(self.calls, [])

    def test_exact_attempt_sanitized_evidence_and_token_free_redirect(self):
        collector = self.collector()
        result = collector.collect(self.assessment)
        self.assertEqual(result['availability'], 'available')
        self.assertEqual(result['provenance']['attempt'], 2)
        self.assertEqual(result['provenance']['revision'], SHA)
        self.assertEqual(len(result['evidence']), 3)
        serialized = json.dumps(result)
        for forbidden in ['CANARY', 'TOKEN_SECRET', 'person@example.com', 'sig=SECRET']:
            self.assertNotIn(forbidden, serialized)
        request = next(headers for url, headers in self.calls if url == self.redirect)
        self.assertNotIn('Authorization', request)
        before = len(self.calls)
        self.assertIn('test failure', collector.call_tool('search_job_log', {'query': 'failure'})['text'])
        self.assertEqual(before, len(self.calls))

    def test_production_digit_string_ids_normalized_without_losing_attempt(self):
        self.assessment['provenance'].update(run_id='11', attempt='2', job_id='22')
        result = self.collector().collect(self.assessment)
        self.assertEqual(result['availability'], 'available')
        self.assertEqual(result['provenance']['run_id'], 11)
        self.assertEqual(result['provenance']['job_id'], 22)
        self.assertEqual(result['provenance']['attempt'], 2)

    def test_search_entire_cached_log_and_distinct_page_citations(self):
        self.body = ('\n'.join('line ' + str(i) for i in range(1200)) + '\nlate marker').encode()
        collector = self.collector()
        collected = collector.collect(self.assessment)
        initial_ids = {e['id'] for e in collected['evidence']}
        before = len(self.calls)
        search = collector.search_job_log('late marker')
        self.assertIn('late marker', search['text'])
        self.assertNotIn(search['id'], initial_ids)
        page = collector.get_job_log(start_line=301, max_lines=2)
        self.assertEqual(page['text'], 'line 300\nline 301')
        self.assertNotEqual(page['id'], search['id'])
        self.assertEqual(collector.get_job_log(start_line=301, max_lines=2), page)
        self.assertEqual(len(self.calls), before)
        self.assertLessEqual(sum(len(e['text'].encode()) for e in collector.evidence), 48 * 1024)
        self.assertEqual(collector.documents, 3)

    def test_private_or_unlisted_repository_rejected_before_logs(self):
        self.data['/repos/org/project']['private'] = True
        self.assertEqual(self.collector().collect(self.assessment)['code'], 'repository_not_public')
        self.assertEqual(len(self.calls), 1)
        self.assessment['scope']['repository'] = 'other/repo'
        self.assertEqual(self.collector().collect(self.assessment)['code'], 'repository_not_allowed')
        self.assertEqual(len(self.calls), 1)

    def test_unknown_attempt_not_replaced_by_latest(self):
        del self.assessment['provenance']['attempt']
        self.assertEqual(self.collector().collect(self.assessment)['code'], 'attempt_unknown')
        self.assertFalse(any('jobs' in url for url, _ in self.calls))

    def test_wrong_attempt_or_job_rejected(self):
        self.data['/repos/org/project/actions/runs/11/attempts/2/jobs?per_page=100']['jobs'][0]['run_attempt'] = 1
        self.assertEqual(self.collector().collect(self.assessment)['code'], 'provenance_mismatch')
        self.assertFalse(any('/logs' in url for url, _ in self.calls))

    def test_redirect_origin_is_validated(self):
        self.redirect = 'https://attacker.example/log?sig=SECRET'
        self.assertEqual(self.collector().collect(self.assessment)['code'], 'invalid_log_redirect')
        self.assertFalse(any('attacker' in url for url, _ in self.calls))

    def test_oversized_document_is_not_accepted(self):
        self.body = b'a' * (MAX_DOCUMENT_BYTES + 1)
        result = self.collector().collect(self.assessment)
        self.assertEqual(result['code'], 'document_too_large')
        self.assertFalse(any(e['url'].endswith('/job/22') for e in result['evidence']))

    def test_report_snapshot_preferred_and_selected_budget_bounded(self):
        self.assessment['report_snapshot'] = {'source_url': f'https://raw.githubusercontent.com/{REPO}/{SHA}/qualification/reports/report.json', 'report': {'error': 'x' * 100000}}
        result = self.collector().collect(self.assessment)
        self.assertEqual(result['evidence'][0]['id'], 'E1')
        self.assertIn('qualification/reports', result['evidence'][0]['url'])
        self.assertLessEqual(sum(len(e['text'].encode()) for e in result['evidence']), 48 * 1024)
        self.assertFalse(any('raw.githubusercontent' in url for url, _ in self.calls))

    def test_pinned_report_survives_absent_attempt_but_run_tools_stay_locked(self):
        del self.assessment['provenance']['attempt']
        self.assessment['report_snapshot'] = {
            'source_url': f'https://raw.githubusercontent.com/{REPO}/{SHA}/qualification/reports/report.json',
            'report': {'error': 'compiler failed: missing header'},
        }
        collector = self.collector()
        result = collector.collect(self.assessment)
        self.assertEqual(result['availability'], 'available')
        self.assertEqual(result['code'], 'report_only_run_unavailable')
        self.assertFalse(result['run_verified'])
        self.assertEqual(len(result['evidence']), 1)
        self.assertIn('missing header', result['evidence'][0]['text'])
        before = len(self.calls)
        for tool in ('get_run_jobs', 'get_job_log', 'get_workflow'):
            self.assertIn('error', collector.call_tool(tool))
        self.assertEqual(before, len(self.calls))

    def test_tools_cannot_change_incident_or_execute_commands(self):
        collector = self.collector()
        collector.collect(self.assessment)
        for name, args in [('shell', {'command': 'rm -rf /'}), ('get_job_log', {'job_id': 33}), ('search_job_log', {'query': '[' * 201})]:
            self.assertIn('error', collector.call_tool(name, args))
        self.assertIn('get_workflow', collector.tools())

    def test_redaction_and_controls(self):
        value = redact('\x1b[31msecret=abc 10.0.0.1 user@example.com\x00 https://example.com/a?token=x CANARY', ['CANARY'])
        for forbidden in ['abc', '10.0.0.1', 'user@example.com', '\x00', '?token', 'CANARY', '\x1b']:
            self.assertNotIn(forbidden, value)


if __name__ == '__main__':
    unittest.main()

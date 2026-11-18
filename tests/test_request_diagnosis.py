import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.request_diagnosis import request_diagnosis


class RequestDiagnosisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.calls = []
        self.now = 0
        self.runs = []
        self.status = 'queued'
        self.conclusion = 'success'
        self.fail_dispatch = False

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def gh_run(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if 'dispatches' in args[2]:
            return subprocess.CompletedProcess(args, int(self.fail_dispatch), '', 'SECRET')
        if '/runs?' in args[2]:
            value = {'workflow_runs': self.runs}
        elif args[1:3] == ['run', 'download']:
            (self.path / 'diagnosis-results.json').write_text('{"schema_version":1}')
            value = {}
        elif args[1:3] == ['run', 'cancel']:
            value = {}
        else:
            value = {**self.child(), 'status': self.status, 'conclusion': self.conclusion}
        return subprocess.CompletedProcess(args, 0, json.dumps(value), '')

    def child(self, **overrides):
        return {'id': 22, 'display_title': 'CI diagnosis 11-2', 'event': 'workflow_dispatch', 'head_branch': 'main', **overrides}

    def request(self, **kwargs):
        return request_diagnosis('org/repo', '11-2', self.path, runner=self.gh_run,
                                 clock=self.clock, sleep=self.sleep, deadline_seconds=10, **kwargs)

    def test_offline_runner_queue_timeout_cancels_exact_child(self):
        self.runs = [self.child()]
        self.assertIsNone(self.request())
        self.assertEqual(self.now, 10)
        self.assertEqual(self.calls[-1][0], ['gh', 'run', 'cancel', '22', '--repo', 'org/repo'])
        self.assertFalse(any('download' in args for args, _ in self.calls))

    def test_unmatched_runs_are_never_cancelled_or_downloaded(self):
        self.runs = [self.child(display_title='CI diagnosis 11-1'), self.child(event='push'), self.child(head_branch='other')]
        self.assertIsNone(self.request())
        self.assertFalse(any('cancel' in args or 'download' in args for args, _ in self.calls))

    def test_success_downloads_exact_named_artifact(self):
        self.runs = [self.child()]
        self.status = 'completed'
        result = self.request()
        self.assertEqual(result, self.path / 'diagnosis-results.json')
        args = next(args for args, _ in self.calls if 'download' in args)
        self.assertIn('diagnosis-results-22', args)
        self.assertFalse(any('cancel' in args for args, _ in self.calls))
        self.assertTrue(all(0 < options['timeout'] <= 20 for _, options in self.calls))

    def test_dispatch_unavailable_no_stale_result_and_no_raise(self):
        (self.path / 'diagnosis-results.json').write_text('{}')
        self.fail_dispatch = True
        self.assertIsNone(self.request())
        self.assertFalse((self.path / 'diagnosis-results.json').exists())
        self.assertEqual(len(self.calls), 1)

    def test_poll_exception_cancels_known_child(self):
        self.runs = [self.child()]
        original = self.gh_run
        def broken(args, **options):
            if args[2].endswith('/actions/runs/22'):
                raise subprocess.TimeoutExpired(args, options['timeout'])
            return original(args, **options)
        self.gh_run = broken
        self.assertIsNone(self.request())
        self.assertEqual(self.calls[-1][0][1:4], ['run', 'cancel', '22'])

    def test_invalid_download_removed_so_parent_cannot_upload_it(self):
        self.runs = [self.child()]
        self.status = 'completed'
        original = self.gh_run
        def invalid(args, **options):
            result = original(args, **options)
            if 'download' in args:
                (self.path / 'diagnosis-results.json').write_text('not json')
            return result
        self.gh_run = invalid
        self.assertIsNone(self.request())
        self.assertFalse((self.path / 'diagnosis-results.json').exists())

    def test_failed_child_does_not_download(self):
        self.runs = [self.child()]
        self.status = 'completed'
        self.conclusion = 'failure'
        self.assertIsNone(self.request())
        self.assertFalse(any('download' in args or 'cancel' in args for args, _ in self.calls))


if __name__ == '__main__':
    unittest.main()

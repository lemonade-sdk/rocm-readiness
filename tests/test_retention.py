import json
import tempfile
import unittest
from pathlib import Path
from scripts.dataset import write_dataset
from tests.test_dataset import normalized, build, SOURCE_A


class RetentionTests(unittest.TestCase):
    def test_cutoff_is_inclusive_utc_and_prunes_expired_reports_and_months(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old = build('old', generated_at='2026-10-31T23:59:59Z')
            old['report_snapshot'] = {'source_url': old['report_url'], 'report': {}}
            first = normalized([old])
            first['generated_at'] = '2026-11-01T12:00:00Z'
            write_dataset(first, root)
            self.assertEqual(len(list((root / 'reports').glob('*.json'))), 1)
            current = normalized([old, build('boundary', generated_at='2026-11-01T00:00:00Z'),
                                  build('recent', generated_at='2026-11-14T10:00:00Z')])
            current['generated_at'] = '2026-11-14T12:00:00Z'
            index = write_dataset(current, root)
            self.assertEqual(index['versions'][0]['build_days'], ['2026-11-01', '2026-11-14'])
            overview = json.loads((root / 'rocm/7.14/overview.json').read_text())
            self.assertEqual(overview['engines'][0]['build_count'], 2)
            self.assertFalse((root / 'rocm/7.14/history/2026-10.json').exists())
            self.assertEqual(list((root / 'reports').glob('*.json')), [])

    def test_previous_records_do_not_bypass_cutoff(self):
        with tempfile.TemporaryDirectory() as prior, tempfile.TemporaryDirectory() as current:
            first = normalized([build('expired', generated_at='2026-10-01T00:00:00Z')])
            write_dataset(first, Path(prior))
            output = normalized([build('recent', generated_at='2026-11-14T00:00:00Z')])
            output['generated_at'] = '2026-11-14T12:00:00Z'
            index = write_dataset(output, Path(current), previous_data=Path(prior))
            self.assertEqual(index['versions'][0]['build_count'], 1)

    def test_measurements_executions_and_unused_systems_expire(self):
        from tests.test_attribution import measurement, evidence
        from tests.test_execution_dataset import attempt
        from scripts.attribution import attribute_stable
        old = measurement(model='model', scenario='chat', kind='latest', source_url=SOURCE_A)
        recent = measurement(model='model', scenario='chat', kind='latest', source_url=SOURCE_A, measured_at='2026-11-01T00:00:00Z', run_id='43', run_url='https://github.com/lemonade-sdk/lemonade/actions/runs/43')
        proof = evidence(run_id='43', evidence_url='https://github.com/lemonade-sdk/lemonade/actions/runs/43/job/99', started_at='2026-10-31T23:00:00Z', completed_at='2026-11-01T01:00:00Z')
        output = normalized(measurements=[old, recent])
        output['generated_at'] = '2026-11-14T12:00:00Z'
        attribute_stable(output, [evidence(), proof])
        # Old valid executions must disappear even if they are the latest for a workload.
        output['executions'] = [attempt()]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            index = write_dataset(output, root)
            data = json.loads((root / 'rocm/10.1/performance.json').read_text())
            self.assertEqual([row['run_id'] for row in data['measurements']], ['43'])
            self.assertEqual(data['systems'], [])
            self.assertFalse((root / 'rocm/10.1/executions.json').exists())
            self.assertEqual(index['stable_performance']['assigned_count'], 1)

    def test_expired_release_build_links_are_removed(self):
        from scripts.dataset import retained_release
        release = {'archives': [{'name': 'asset', 'qualification_build_id': 'expired',
            'qualification_source_id': 'source', 'report_url': 'https://example.test/report',
            'qualified': True, 'overall': 'pass', 'attached_report': 'https://example.test/asset'}]}
        cleaned = retained_release(release, [])
        self.assertEqual(cleaned['archives'], [{'name': 'asset', 'attached_report': 'https://example.test/asset'}])
        self.assertIn('qualified', release['archives'][0])

    def test_current_tracks_remain_in_catalog_when_all_builds_have_expired(self):
        output = normalized([build()])
        output['generated_at'] = '2026-11-14T12:00:00Z'
        output['readiness'] = {'stable_anchor': '7.14', 'tracks': ['7.14']}
        with tempfile.TemporaryDirectory() as folder:
            index = write_dataset(output, Path(folder))
            self.assertEqual(index['versions'][0]['rocm_version'], '7.14')
            self.assertEqual(index['versions'][0]['build_count'], 0)
            self.assertEqual(index['versions'][0]['build_days'], [])

    def test_retained_measurements_release_expired_build_links_without_losing_proof(self):
        from scripts.attribution import attribute_stable
        from tests.test_attribution import measurement, evidence, PACKAGE
        row = measurement(model='model', scenario='chat', kind='latest', source_url=SOURCE_A,
                          measured_at='2026-10-28T10:05:00Z')
        proof = evidence(completed_at='2026-10-28T11:00:00Z')
        qualification = build('linked', rocm_version='10.1',
                              generated_at='2026-10-27T10:00:00Z',
                              artifact=PACKAGE.rsplit('/', 1)[-1])
        first = normalized([qualification], [row])
        first['generated_at'] = '2026-10-28T12:00:00Z'
        first['sources'][0]['url'] = 'https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/' + 'a' * 40 + '/qualification/index.json'
        attribute_stable(first, [proof])
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            write_dataset(first, root / 'prior')
            for when, expected in [('2026-11-09', 'linked'), ('2026-11-10', None)]:
                output = normalized()
                output['generated_at'] = when + 'T12:00:00Z'
                destination = root / when
                write_dataset(output, destination, previous_data=root / 'prior')
                result = json.loads((destination / 'rocm/10.1/performance.json').read_text())['measurements'][0]
                self.assertEqual(result['qualification_build_id'], expected)
                self.assertEqual(result['attribution']['status'], 'matched' if expected else 'rocm_identified')
                for field in ('evidence_url', 'log_sha256', 'package_url'):
                    self.assertEqual(result['attribution'][field], proof[field])

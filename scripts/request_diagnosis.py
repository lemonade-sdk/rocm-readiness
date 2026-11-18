"""Request bounded self-hosted diagnosis; unavailable analysis never blocks publishing."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

DEADLINE_SECONDS = 8 * 60
MAX_RESULT_BYTES = 2 * 1024 * 1024


def request_diagnosis(repository, request_id, output_dir, *, runner=subprocess.run,
                      clock=time.monotonic, sleep=time.sleep, deadline_seconds=DEADLINE_SECONDS):
    """Return a downloaded result path, or None without exposing command output.

    The title contains the parent's immutable run/attempt identity. Only an exact
    workflow/event/branch/title match may be downloaded or cancelled.
    """
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        return None
    if not re.fullmatch(r'[0-9]+-[0-9]+', request_id):
        return None
    destination = Path(output_dir)
    result_path = destination / 'diagnosis-results.json'
    try:
        if result_path.exists() or result_path.is_symlink():
            # A failed request must not accidentally reuse a previous result.
            result_path.unlink()
    except OSError:
        return None
    end = clock() + min(max(deadline_seconds, 0), DEADLINE_SECONDS)
    child_id = None
    completed = False
    delivered = False

    def command(*args, cleanup=False):
        remaining = end - clock()
        if remaining <= 0 and not cleanup:
            raise TimeoutError()
        value = runner(['gh', *args], capture_output=True, text=True,
                       timeout=max(0.1, min(20, remaining)) if not cleanup else 10,
                       check=False)
        if value.returncode:
            raise RuntimeError('diagnosis request unavailable')
        return value.stdout

    try:
        command('api', f'repos/{repository}/actions/workflows/diagnosis.yml/dispatches',
                '--method', 'POST', '-f', 'ref=main', '-f', f'inputs[request_id]={request_id}')
        while clock() < end:
            if child_id is None:
                response = json.loads(command('api',
                    f'repos/{repository}/actions/workflows/diagnosis.yml/runs?event=workflow_dispatch&branch=main&per_page=100'))
                matches = [run for run in response.get('workflow_runs', [])
                           if run.get('display_title') == f'CI diagnosis {request_id}'
                           and run.get('event') == 'workflow_dispatch'
                           and run.get('head_branch') == 'main'
                           and type(run.get('id')) is int and run['id'] > 0]
                if len(matches) > 1:
                    return None
                if matches:
                    child_id = matches[0]['id']
            if child_id is not None:
                run = json.loads(command('api', f'repos/{repository}/actions/runs/{child_id}'))
                if (run.get('id') != child_id or run.get('display_title') != f'CI diagnosis {request_id}'
                        or run.get('event') != 'workflow_dispatch' or run.get('head_branch') != 'main'):
                    return None
                if run.get('status') == 'completed':
                    completed = True
                    if run.get('conclusion') != 'success':
                        return None
                    destination.mkdir(parents=True, exist_ok=True)
                    command('run', 'download', str(child_id), '--repo', repository,
                            '--name', f'diagnosis-results-{child_id}', '--dir', str(destination))
                    if not result_path.is_file() or result_path.is_symlink() or result_path.stat().st_size > MAX_RESULT_BYTES:
                        return None
                    # Trust decisions and field validation remain with the writer.
                    document = json.loads(result_path.read_text(encoding='utf-8'))
                    if not isinstance(document, dict):
                        return None
                    delivered = True
                    return result_path
            sleep(min(5, max(0, end - clock())))
    except (OSError, ValueError, TypeError, RuntimeError, TimeoutError, subprocess.SubprocessError):
        return None
    finally:
        if not delivered:
            try:
                result_path.unlink(missing_ok=True)
            except OSError:
                pass
        if child_id is not None and not completed:
            try:
                command('run', 'cancel', str(child_id), '--repo', repository, cleanup=True)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default=os.environ.get('GITHUB_REPOSITORY', ''))
    parser.add_argument('--request-id', default=(os.environ.get('GITHUB_RUN_ID', '') + '-'
                                               + os.environ.get('GITHUB_RUN_ATTEMPT', '')))
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args(argv)
    result = request_diagnosis(args.repository, args.request_id, args.output_dir)
    if result is None:
        print('Diagnosis unavailable; unresolved results remain eligible for investigation.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

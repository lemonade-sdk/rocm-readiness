"""Conservative proof for skipped-job prerequisite explanations.

Only cited, incident-bound observations and literal workflow job mappings count.
This intentionally supports a YAML subset; ambiguous syntax stays unexplained.
"""
import json
import re

_ID = r"[A-Za-z_][A-Za-z0-9_-]*"


def _scalar(value):
    value = value.strip()
    if value[:1] in ("'", '"'):
        if len(value) < 2 or value[-1] != value[0]:
            return None
        value = value[1:-1]
    return value if re.fullmatch(_ID, value) else None


def workflow_jobs(text):
    """Return job-level scalar fields for conventional block YAML, else None.

    Nested step text is ignored. Anchors, aliases, flow job mappings and duplicate
    keys are unsupported so inheritance cannot silently alter a dependency.
    """
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line == 'jobs:']
    if len(starts) != 1 or '\t' in text:
        return None
    jobs, current, field = {}, None, None
    for line in lines[starts[0] + 1:]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            break
        if indent == 2:
            match = re.fullmatch(r'  (' + _ID + r'):\s*', line)
            if not match or match[1] in jobs:
                return None
            current, field = match[1], None
            jobs[current] = {}
        elif indent == 4 and field == 'steps' and line.lstrip().startswith('- '):
            continue
        elif indent == 4:
            match = re.fullmatch(r'    (' + _ID + r'):\s*(.*?)\s*', line)
            if current is None or not match or match[1] in jobs[current]:
                return None
            field = match[1]
            value = match[2]
            if field == '<<' or value.startswith(('&', '*', '{')):
                return None
            jobs[current][field] = value
        elif indent > 4 and current and field in ('needs', 'if', 'name'):
            jobs[current][field] += '\n' + line.strip()
        elif indent < 4:
            return None
    return jobs or None


def _needs(value):
    if '\n' in value:
        values = value.splitlines()
        if values[0]:
            return None
        values = [v[2:] if v.startswith('- ') else '' for v in values[1:]]
    elif value.startswith('[') and value.endswith(']'):
        values = value[1:-1].split(',')
    else:
        values = [value]
    parsed = [_scalar(v) for v in values]
    return parsed if parsed and all(parsed) and len(set(parsed)) == len(parsed) else None


def _gate_blocks(condition, dependency):
    """Prove default success gate or a literal result gate excludes failure.

    A narrow conjunction grammar permits unknown surrounding conditions, but
    never infers their values. OR outside the recognized result gate is rejected.
    """
    if not condition:
        return True
    condition = condition.strip()
    if condition.startswith('${{') and condition.endswith('}}'):
        condition = condition[3:-2].strip()
    # Collapse exactly the common success-or-skipped result gate.
    term = r"needs\." + re.escape(dependency) + r"\.result\s*==\s*(['\"])(success|skipped)\1"
    pair = r'\(\s*' + term + r'\s*\|\|\s*' + term + r'\s*\)'
    condition, count = re.subn(pair, 'BLOCKED_DEPENDENCY', condition)
    condition, singles = re.subn(term, 'BLOCKED_DEPENDENCY', condition)
    if not count and not singles:
        return False
    if '||' in condition or '\n' in condition or '!' in condition:
        return False
    parts = [part.strip() for part in condition.split('&&')]
    # Other conjuncts cannot make a false prerequisite gate true. Reject syntax
    # that could change its grouping or interpretation rather than evaluating it.
    return 'BLOCKED_DEPENDENCY' in parts and all(
        part == 'BLOCKED_DEPENDENCY' or re.fullmatch(
            r"always\(\)|[A-Za-z_][A-Za-z0-9_.-]*\s*==\s*(['\"])[^'\"\n]*\1", part
        ) for part in parts
    )


def validate_support(result, evidence, incident, provenance=None):
    """Require the exact deterministic sentence for a proven skipped dependency."""
    incident = incident or {}
    status = incident.get('observed', {}).get('status') or incident.get('status')
    if status not in ('skip', 'skipped') or result.get('certainty') != 'likely':
        return True
    cause = supported_skip_cause(evidence, incident, provenance, result.get('evidence_ids'))
    return cause is not None and result.get('cause') == cause


def supported_skip_cause(evidence, incident, provenance=None, cited_ids=None):
    """Return a fixed sentence only for an observed, revision-bound dependency.

    No model prose is parsed as a causal assertion. A caller may replace a model
    answer with this sentence; the trusted writer independently proves it again.
    """
    incident = incident or {}
    status = incident.get('observed', {}).get('status') or incident.get('status')
    if status not in ('skip', 'skipped') or not isinstance(evidence, list):
        return None
    if cited_ids is not None and (not isinstance(cited_ids, list) or not all(isinstance(item, str) for item in cited_ids)):
        return None
    provenance = provenance or incident.get('provenance', {})
    scope = incident.get('scope', {})
    repo = provenance.get('repository') or scope.get('repository')
    run, attempt = provenance.get('run_id'), provenance.get('attempt')
    revision, path = provenance.get('revision'), provenance.get('workflow')
    job_id = provenance.get('job_id')
    if not all((repo, run, attempt, revision, path, job_id)):
        return None
    cited = [row for row in evidence if isinstance(row, dict) and (cited_ids is None or row.get('id') in cited_ids)]
    jobs_url = f'https://github.com/{repo}/actions/runs/{run}/attempts/{attempt}'
    workflow_url = f'https://github.com/{repo}/blob/{revision}/{path}'
    definitions = []
    observed = []
    for row in cited:
        if row.get('kind') == 'workflow' and row.get('url') == workflow_url:
            if row.get('workflow_complete') is not True:
                continue
            parsed = workflow_jobs(row.get('text', ''))
            if parsed:
                definitions.append(parsed)
        if row.get('kind') == 'jobs' and row.get('url') == jobs_url:
            try:
                packet = json.loads(row.get('text', ''))
            except (TypeError, ValueError):
                continue
            if isinstance(packet, dict) and packet.get('run_id') == run and packet.get('attempt') == attempt:
                observed.append(packet.get('jobs', []))
    if not definitions or len(observed) != 1:
        return None
    merged = {}
    for definition in definitions:
        for key, value in definition.items():
            if key in merged and merged[key] != value:
                return None
            merged[key] = value
    definitions, jobs = merged, observed[0]
    if not isinstance(jobs, list) or not all(isinstance(job, dict) for job in jobs):
        return None
    if any(job.get('run_id', run) != run or job.get('run_attempt', attempt) != attempt for job in jobs):
        return None
    targets = [job for job in jobs if job.get('id') == job_id and job.get('conclusion') == 'skipped']
    if len(targets) != 1:
        return None
    target = targets[0]
    matches = [key for key, data in definitions.items() if target.get('name') == (data.get('name') or key).strip("'\"")]
    if len(matches) != 1:
        return None
    data = definitions[matches[0]]
    dependencies = _needs(data.get('needs', ''))
    if not dependencies:
        return None
    for dependency in dependencies:
        definition = definitions.get(dependency)
        if definition is None or definition.get('continue-on-error', 'false') != 'false':
            continue
        name = (definition.get('name') or dependency).strip("'\"")
        prerequisites = [job for job in jobs if job.get('name') == name]
        if len(prerequisites) != 1 or prerequisites[0].get('conclusion') not in ('failure', 'cancelled'):
            continue
        if not _gate_blocks(data.get('if', ''), dependency):
            continue
        return ('A required job failed, so this job was skipped.'
                if prerequisites[0]['conclusion'] == 'failure'
                else 'A required job was cancelled, so this job was skipped.')
    return None

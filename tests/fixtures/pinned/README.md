# Pinned producer examples

These are exact JSON subtrees from the immutable producer documents in
`manifest.json`, selected to keep the regression suite small. They are not full
producer feeds and their record counts are not production totals.

- `qualification-fragments.json`: five ROCm 10.1 records: Linux/Windows b11997,
  Linux/Windows b11972, and Linux b11932. Each fragment retains its original
  `/builds/<index>` pointer.
- `performance-fragments.json`: one complete model/scenario latest group, its
  five stable historical observations, and the two producer system descriptions.
  The latest group deliberately includes other forks so the test exercises the
  configured stable-fork filter.
- `package-evidence.json`: the actual download line from benchmark job
  `122306719689`, the job's run/time metadata, and the package-evidence record.
  `log_sha256` hashes the complete retrieved job log; `excerpt_sha256` hashes
  only the retained line. The complete log is not embedded here.

`test_pinned_mappings.py` contains hand-checked expected identities, timestamps,
metrics, counts, selected latest packages, and the package association. The
fixture checksum test checks local integrity, not the truth of an upstream
claim. To independently verify the fragments against their producers:

```sh
uv run --no-project --python 3.12 python - <<'PY'
import hashlib, json, urllib.request
from pathlib import Path
root = Path('tests/fixtures/pinned')
manifest = json.loads((root / 'manifest.json').read_text())
for name, source in manifest['sources'].items():
    with urllib.request.urlopen(source['url']) as response:
        raw = response.read()
    assert hashlib.sha256(raw).hexdigest() == source['document_sha256']
    document = json.loads(raw)
    for fragment in json.loads((root / f'{name}-fragments.json').read_text()):
        value = document
        for part in fragment['pointer'].lstrip('/').split('/'):
            key = part.replace('~1', '/').replace('~0', '~')
            value = value[int(key)] if isinstance(value, list) else value[key]
        assert value == fragment['value'], fragment['pointer']
    print(name, source['commit'], 'verified')
PY
```

The qualification adapter is first checked against the excerpt array's local
positions. The end-to-end test then explicitly restores the original producer
positions from the fragment manifest before writing provenance URLs. Synthetic
wrong backend/package variants are created only inside tests; they are not
represented as captured producer evidence. Older historical observations lack
hardware/context fields in the producer itself; the tests retain those nulls.

#!/usr/bin/env bash
# Run only on a separately approved, exclusively reserved inference runner.
# The runner owner provisions Lemonade 11.9.0; this script installs no software.
set -euo pipefail

output=${1:?usage: run-diagnosis.sh OUTPUT}
root=$(git rev-parse --show-toplevel)
cd "$root"

# The first pass may retrieve public evidence but never starts inference. Keep
# its verified explanations even if this runner cannot provision the model.
mode=${2:-}
if [ "$mode" != "--model-only" ]; then
  if [ -n "$mode" ] || [ "$#" -gt 2 ]; then
    echo "usage: run-diagnosis.sh OUTPUT" >&2
    exit 2
  fi
  preflight=$(python3 - "$output" <<'PREFLIGHT'
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
from scripts.assessments import evaluate_dataset, validate_config
from scripts.diagnosis import diagnosis_artifact, prepare_assessments
from scripts.diagnosis_evidence import EvidenceCollector
from scripts.notifications import write_atomic

class NoModel:
    def diagnose(self, evidence, tools=None):
        incident = evidence.get("incident", {})
        status = incident.get("observed", {}).get("status") or incident.get("status")
        code = "cancellation_reason_unavailable" if status in ("cancelled", "canceled") else "model_required"
        return {"certainty": "unknown", "code": code}

rules = validate_config(json.load(open('alert-rules.json')))
rows = evaluate_dataset('data', rules, datetime.now(timezone.utc).isoformat())
sources = json.load(open('sources.json'))
repositories = {source['repository'] for source in sources['sources'] if source.get('repository')}
repositories.update(project['repository'] for project in sources.get('projects', []) if project.get('repository'))
collector = EvidenceCollector(repositories, token=os.environ.get('GH_TOKEN'))
collector.deadline = time.monotonic() + 120
prepared = prepare_assessments(rows, enabled=True, collector=collector, client=NoModel(),
                               cache_path=Path('data/diagnosis-cache.json'))
write_atomic(Path(sys.argv[1]), diagnosis_artifact(rows, prepared))
print('model_required' if any(row.get('diagnosis', {}).get('code') == 'model_required'
                              for row in prepared) else 'complete')
PREFLIGHT
)
  if [ "$preflight" = "complete" ]; then
    exit 0
  fi
  if [ "$preflight" != "model_required" ]; then
    echo "Invalid diagnosis preflight result" >&2
    exit 1
  fi
  model_output=$(mktemp "${output}.model.XXXXXX")
  # A separate shell keeps errexit active throughout provisioning and cleanup.
  # Its partial artifact never replaces the already usable preflight result.
  if bash "$root/scripts/run-diagnosis.sh" "$model_output" --model-only; then
    mv -f -- "$model_output" "$output"
  else
    echo "Model diagnosis unavailable; retained rules and verified source explanations." >&2
    rm -f -- "$model_output"
  fi
  exit 0
fi

binary=${LEMONADE_BINARY:-lemond}
"$binary" --version | python3 -c 'import re,sys; assert re.search(r"\b11\.9\.0\b", sys.stdin.read()), "Lemonade 11.9.0 required"'
cache=${ROCM_READINESS_MODEL_CACHE:?runner owner must configure a persistent model cache}
mkdir -p "$cache"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
server_pid=''
job_home=$(mktemp -d "${RUNNER_TEMP:?}/rocm-diagnosis-home.XXXXXX")
cleanup() {
  if [ -n "$server_pid" ]; then
    curl --noproxy '*' -fsS --max-time 5 -X POST "http://127.0.0.1:$port/internal/shutdown" >/dev/null 2>&1 || true
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$job_home"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# The server receives no GitHub credential or recipient configuration.
env -u GH_TOKEN -u GITHUB_TOKEN -u ROCM_READINESS_NOTIFICATION_LIST -u ROCM_READINESS_TEST_NOTIFICATION_LIST \
  HOME="$job_home" HF_HOME="$cache" "$binary" "$cache" --host 127.0.0.1 --port "$port" --no-broadcast \
  >"${RUNNER_TEMP:?}/diagnosis-server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 60); do
  if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/api/v1/health" >/dev/null 2>&1; then break; fi
  kill -0 "$server_pid" 2>/dev/null || exit 1
  sleep 2
done
curl --noproxy '*' -fsS --max-time 5 "http://127.0.0.1:$port/api/v1/health" >/dev/null
curl --noproxy '*' -fsS --max-time 300 -X POST "http://127.0.0.1:$port/api/v1/pull" \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"Qwen3.6-35B-A3B-MTP-GGUF"}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("status") == "success"'
curl --noproxy '*' -fsS --max-time 180 -X POST "http://127.0.0.1:$port/api/v1/load" \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"Qwen3.6-35B-A3B-MTP-GGUF","ctx_size":32768,"llamacpp_backend":"vulkan","save_options":false}' \
  | python3 -c 'import json,sys; assert json.load(sys.stdin).get("status") == "success"'
python3 scripts/notify.py --diagnose --diagnose-only "$output" \
  --lemonade-url "http://127.0.0.1:$port/v1"

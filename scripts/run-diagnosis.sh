#!/usr/bin/env bash
# Run only on a separately approved, exclusively reserved inference runner.
# The runner owner provisions Lemonade 11.9.0; this script installs no software.
set -euo pipefail

output=${1:?usage: run-diagnosis.sh OUTPUT}
root=$(git rev-parse --show-toplevel)
cd "$root"

# Known rule explanations require neither a server nor a model download.
if ! python3 - <<'PY'
from datetime import datetime, timezone
import json
from scripts.assessments import evaluate_dataset, validate_config
from scripts.diagnosis import rule_explains
rules = validate_config(json.load(open('alert-rules.json')))
rows = evaluate_dataset('data', rules, datetime.now(timezone.utc).isoformat())
raise SystemExit(0 if any(row['actionable'] and not rule_explains(row) for row in rows) else 1)
PY
then
  python3 scripts/notify.py --diagnose-only "$output"
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

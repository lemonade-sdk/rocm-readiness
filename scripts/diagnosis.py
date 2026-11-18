"""Rules-first, evidence-backed diagnosis before unresolved-incident escalation."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import time

if __package__:
    from .notifications import write_atomic
else:
    from notifications import write_atomic

DEFAULT_MODEL = "Qwen3.6-35B-A3B-MTP-GGUF"
ANALYZER_VERSION = "ci-diagnosis-8"
PROMPT_VERSION = "ci-diagnosis-8"
TOOLS = ("get_job_log", "search_job_log", "get_workflow", "get_run_jobs", "get_report")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def input_hash(assessment):
    return digest({key: value for key, value in assessment.items()
                   if key not in {"diagnosis", "escalation_required", "notification", "evaluated_at"}})


def rule_explains(assessment):
    """A verdict/failed-step label alone does not establish a causal explanation."""
    return (not assessment.get("actionable", False)
            or assessment.get("explanation_verified") is True
            or assessment.get("explanation_basis") in
            {"dependency", "permitted", "suppressed", "recovered", "configured"})


def supported_result(result, evidence, incident=None, provenance=None):
    if not isinstance(result, dict):
        return False
    if result.get("method") == "model":
        if __package__:
            from .diagnosis_model import validate_result
        else:
            from diagnosis_model import validate_result
        return validate_result(result, evidence, incident, provenance)
    cause = result.get("cause")
    ids = result.get("evidence_ids")
    known = {item.get("id") for item in evidence if isinstance(item, dict)}
    return (
        result.get("method") in {"model", "deterministic"}
        and result.get("certainty") == ("likely" if result.get("method") == "model" else "verified")
        and isinstance(cause, str) and 0 < len(cause.strip()) <= 160
        and not re.search(r"[@<>\r\n]|https?://|\x00|[\x01-\x1f\x7f]", cause)
        and isinstance(ids, list) and bool(ids)
        and all(isinstance(identity, str) and identity in known for identity in ids)
    )


def _apply(assessment, result):
    assessment["diagnosis"] = {key: result[key] for key in
                                ("method", "certainty", "cause", "evidence_ids")}
    assessment["explanation"] = result["cause"]
    assessment["escalation_required"] = False


def _unknown(assessment, code):
    code = code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,80}", code) else "unsupported"
    assessment["diagnosis"] = {"certainty": "unknown", "code": code}
    assessment["escalation_required"] = bool(assessment.get("actionable"))


def validate_cache(value):
    """Validate a public-safe cache: no excerpts, prompts, or arbitrary tool data."""
    if (not isinstance(value, dict) or set(value) != {"schema_version", "results"}
            or value.get("schema_version") != 1 or not isinstance(value.get("results"), dict)):
        raise ValueError("invalid diagnosis cache")
    if __package__:
        from .diagnosis_model import redact
    else:
        from diagnosis_model import redact
    for key, entry in value["results"].items():
        if (not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key)
                or not isinstance(entry, dict) or set(entry) != {"result", "tool_calls", "evidence_hash"}
                or not isinstance(entry.get("evidence_hash"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", entry["evidence_hash"])):
            raise ValueError("invalid diagnosis cache entry")
        result = entry["result"]
        if not isinstance(result, dict):
            raise ValueError("invalid diagnosis cache result")
        if result.get("certainty") == "unknown":
            if set(result) - {"certainty", "code", "method"} or not re.fullmatch(r"[a-z_]{1,80}", result.get("code", "")):
                raise ValueError("invalid diagnosis unknown")
        else:
            if set(result) != {"method", "certainty", "cause", "evidence_ids"}:
                raise ValueError("invalid diagnosis result")
            ids = result.get("evidence_ids", [])
            if not isinstance(ids, list) or not supported_result(result, [{"id": identity} for identity in ids]):
                raise ValueError("invalid diagnosis result")
        calls = entry["tool_calls"]
        if not isinstance(calls, list) or len(calls) > 8:
            raise ValueError("invalid diagnosis tools")
        for call in calls:
            if (not isinstance(call, dict) or set(call) != {"name", "arguments"}
                    or call["name"] not in TOOLS or not isinstance(call["arguments"], dict)):
                raise ValueError("invalid diagnosis tool")
            args = call["arguments"]
            if call["name"] == "search_job_log":
                query = args.get("query")
                if (set(args) != {"query"} or not isinstance(query, str) or not 1 <= len(query) <= 200
                        or redact(query) != query or re.search(r"[\x00-\x1f\x7f]", query)):
                    raise ValueError("invalid diagnosis search")
            elif call["name"] == "get_job_log":
                if (set(args) - {"start_line", "max_lines"}
                        or any(type(v) is not int or v < 1 for v in args.values())
                        or args.get("max_lines", 200) > 200):
                    raise ValueError("invalid diagnosis log range")
            elif call["name"] == "get_workflow":
                if (set(args) - {"job", "start_line", "max_lines"}
                        or any(type(v) is not int or v < 1 for k, v in args.items() if k != "job")
                        or args.get("max_lines", 200) > 400
                        or ("job" in args and (not isinstance(args["job"], str)
                            or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", args["job"]) or "start_line" in args))):
                    raise ValueError("invalid diagnosis workflow range")
            elif args:
                raise ValueError("invalid diagnosis arguments")
    return value


def _cache(path):
    if path is None or not Path(path).exists():
        return {"schema_version": 1, "results": {}}
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        if value.get("schema_version") == 1 and isinstance(value.get("results"), dict):
            return validate_cache(value)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return {"schema_version": 1, "results": {}}


def prepare_assessments(assessments, *, cache_path=None, enabled=False,
                        collector=None, client=None, model=DEFAULT_MODEL):
    """Never change the producer verdict, actionability, or incident identity."""
    cache = _cache(cache_path)
    output = []
    for original in assessments:
        assessment = deepcopy(original)
        output.append(assessment)
        assessment["escalation_required"] = bool(assessment.get("actionable"))
        if rule_explains(assessment):
            assessment["escalation_required"] = False
            continue
        if not enabled:
            _unknown(assessment, "disabled")
            continue
        if collector is None or client is None:
            _unknown(assessment, "unavailable")
            continue
        try:
            package = collector.collect(assessment)
            evidence = package.get("evidence", [])
            key = digest({"incident": assessment["id"], "observation": assessment.get("observation_id"),
                          "input": input_hash(original), "evidence": package,
                          "analyzer": ANALYZER_VERSION, "prompt": PROMPT_VERSION, "model": model})
            cached = cache["results"].get(key)
            calls = []
            result = cached.get("result") if isinstance(cached, dict) else None
            if result is not None:
                for call in cached.get("tool_calls", []):
                    collector.call_tool(call["name"], call["arguments"])
                evidence = getattr(collector, "evidence", evidence)
                if cached["evidence_hash"] != digest(evidence):
                    # The selected tool evidence changed; obtain one fresh analysis.
                    package = collector.collect(assessment)
                    evidence = package.get("evidence", [])
                    result, cached, calls = None, None, []
            if result is None:
                result = package.get("diagnosis")
                if not supported_result(result, evidence, assessment, package.get("provenance")):
                    if not evidence:
                        _unknown(assessment, package.get("code", "evidence_unavailable"))
                        continue
                    def call(name, arguments):
                        if name == "search_job_log" and isinstance(arguments.get("query"), str):
                            if __package__:
                                from .diagnosis_model import redact
                            else:
                                from diagnosis_model import redact
                            arguments = {**arguments, "query": redact(arguments["query"])}
                        calls.append({"name": name, "arguments": arguments})
                        return collector.call_tool(name, arguments)
                    tools = {name: (lambda name=name, **arguments: call(name, arguments))
                             for name in TOOLS}
                    result = client.diagnose(package, tools=tools)
                # Tool reads may add evidence; retain only hashes and supported short output.
                evidence = getattr(collector, "evidence", evidence)
                if not isinstance(evidence, list):
                    evidence = package.get("evidence", [])
                if not supported_result(result, evidence, assessment, package.get("provenance")):
                    if not isinstance(result, dict) or result.get("certainty") != "unknown" or result.get("code") != "insufficient_evidence":
                        _unknown(assessment, result.get("code", "unsupported") if isinstance(result, dict) else "unsupported")
                        continue
                    result = {"certainty": "unknown", "code": "insufficient_evidence"}
                entry = {"result": result, "tool_calls": calls, "evidence_hash": digest(evidence)}
                validate_cache({"schema_version": 1, "results": {key: entry}})
                cache["results"][key] = entry
            if supported_result(result, evidence, assessment, package.get("provenance")):
                _apply(assessment, result)
            else:
                _unknown(assessment, result.get("code", "unsupported") if isinstance(result, dict) else "unsupported")
            assessment["diagnosis"]["cache_key"] = key
            assessment["diagnosis"]["evidence_hash"] = digest(evidence)
            assessment["diagnosis"]["tool_calls"] = calls if cached is None else cached.get("tool_calls", [])
        except (OSError, ValueError, TypeError, KeyError, RuntimeError, TimeoutError):
            _unknown(assessment, "analysis_unavailable")
    if enabled and cache_path is not None:
        write_atomic(cache_path, validate_cache(cache))
    return output


def diagnosis_artifact(originals, prepared):
    return {"schema_version": 1, "model": DEFAULT_MODEL, "analyzer": ANALYZER_VERSION,
            "results": [{"id": original["id"], "observation_id": original.get("observation_id"),
                         "input_hash": input_hash(original), "diagnosis": row.get("diagnosis", {})}
                        for original, row in zip(originals, prepared)]}


def import_results(assessments, artifact, *, collector, cache_path=None, clock=time.monotonic):
    """Re-fetch evidence before accepting an untrusted read-only runner artifact."""
    prepared = prepare_assessments(assessments)
    cache = _cache(cache_path)
    if (not isinstance(artifact, dict) or artifact.get("schema_version") != 1
            or artifact.get("model") != DEFAULT_MODEL or artifact.get("analyzer") != ANALYZER_VERSION):
        return prepared
    rows = artifact.get("results", [])
    if not isinstance(rows, list) or len(rows) > 5000:
        return prepared
    deadline = clock() + 120
    collector.deadline = deadline
    for original, assessment in zip(assessments, prepared):
        if clock() >= deadline:
            break
        if rule_explains(original):
            continue
        matches = [row for row in rows if isinstance(row, dict)
                   and row.get("id") == original["id"]
                   and row.get("observation_id") == original.get("observation_id")
                   and row.get("input_hash") == input_hash(original)]
        if len(matches) != 1:
            continue
        result = matches[0].get("diagnosis")
        # Deterministic claims must be independently reproduced by the writer.
        if (not isinstance(result, dict)
                or not isinstance(result.get("method", ""), str)
                or (result.get("method") not in ("model", "deterministic") and result.get("certainty") != "unknown")
                or any(not isinstance(result.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", result[key])
                       for key in ("cache_key", "evidence_hash"))):
            continue
        if result.get("certainty") == "unknown" and result.get("code") != "insufficient_evidence":
            continue
        try:
            package = collector.collect(original)
            if clock() >= deadline:
                break
            if result.get("method") == "deterministic" and package.get("diagnosis") != {k: result.get(k) for k in ("method", "certainty", "cause", "evidence_ids")}:
                continue
            key = digest({"incident": original["id"], "observation": original.get("observation_id"),
                          "input": input_hash(original), "evidence": package,
                          "analyzer": ANALYZER_VERSION, "prompt": PROMPT_VERSION, "model": DEFAULT_MODEL})
            if result.get("cache_key") != key:
                continue
            calls = result.get("tool_calls", [])
            short_result = ({"certainty": "unknown", "code": "insufficient_evidence"} if result.get("certainty") == "unknown" else
                            {k: result.get(k) for k in ("method", "certainty", "cause", "evidence_ids")})
            validate_cache({"schema_version": 1, "results": {key: {"result": short_result, "tool_calls": calls, "evidence_hash": result.get("evidence_hash")}}})
            if not isinstance(calls, list) or len(calls) > 8:
                continue
            for call in calls:
                if not isinstance(call, dict) or call.get("name") not in TOOLS or not isinstance(call.get("arguments"), dict):
                    raise ValueError("invalid diagnosis tool replay")
                if clock() >= deadline:
                    raise TimeoutError("diagnosis verification deadline")
                collector.call_tool(call["name"], call["arguments"])
            if clock() >= deadline:
                break
            evidence = getattr(collector, "evidence", package.get("evidence", []))
            if result.get("evidence_hash") != digest(evidence):
                continue
            if result.get("certainty") == "unknown":
                cache["results"][key] = {"result": {"certainty": "unknown", "code": "insufficient_evidence"}, "tool_calls": calls, "evidence_hash": digest(evidence)}
            elif supported_result(result, evidence, original, package.get("provenance")):
                _apply(assessment, result)
                cache["results"][key] = {"result": {k: result[k] for k in ("method", "certainty", "cause", "evidence_ids")}, "tool_calls": calls, "evidence_hash": digest(evidence)}
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            pass
    if cache_path is not None:
        write_atomic(cache_path, validate_cache(cache))
    return prepared

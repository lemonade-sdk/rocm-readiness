"""Bounded, read-only public CI evidence for diagnosis; never persist raw logs."""

import base64
import hashlib
from http.client import HTTPException
import ipaddress
import json
import re
from time import monotonic
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_DOCUMENTS = 5
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
MAX_EVIDENCE_BYTES = 48 * 1024
API = "https://api.github.com"
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
SHA = re.compile(r"[a-fA-F0-9]{40}")


class EvidenceUnavailable(ValueError):
    """An evidence boundary or upstream availability check failed."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def redact(text, secrets=()):
    """Remove common credentials, addresses, terminal escapes and explicit canaries."""
    text = str(text)
    for secret in sorted((s for s in secrets if isinstance(s, str) and s), key=len, reverse=True):
        text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)
    text = re.sub(r"(?i)\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b", "[REDACTED]", text)
    text = re.sub(r"(?i)\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|token|basic)\s+)?[^\r\n,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|token)[\"\']?\s*[:=]\s*[\"\']?)[^\s,;\"\'}]+", r"\1[REDACTED]", text)
    text = re.sub(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}", "[ADDRESS]", text)
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[ADDRESS]", text)
    # IPv6 is checked rather than treating every colon-separated error code as an address.
    def ipv6(match):
        try:
            ipaddress.IPv6Address(match.group())
            return "[ADDRESS]"
        except ValueError:
            return match.group()
    text = re.sub(r"(?<![\w:])[0-9a-fA-F:]{0,39}:[0-9a-fA-F:]{1,39}(?![\w:])", ipv6, text)
    text = re.sub(r"https?://[^\s<>\"']+", lambda m: m.group().split("?")[0].split("#")[0], text)
    return text


def _trim(text, limit):
    return text.encode("utf-8")[:limit].decode("utf-8", errors="ignore")


class EvidenceCollector:
    """One instance per incident; tool arguments cannot select another incident.

    ``request(url, headers, max_bytes)`` is injectable for offline tests and returns
    ``(status, headers, bytes)``. Redirects must be returned, never followed.
    """

    def __init__(self, allowed_repositories, token=None, request=None, secrets=()):
        self.deadline = None
        self.allowed = {repo.lower() for repo in allowed_repositories if REPOSITORY.fullmatch(repo)}
        self.token = token
        self.request = request or self._request
        self.secrets = tuple(secrets) + ((token,) if token else ())
        self._reset()

    def _reset(self):
        self.evidence = []
        self.provenance = {}
        self.documents = 0
        self.bytes = 0
        self.cache = {}
        self.repo = None
        self.assessment = {}
        self.requests = 0
        self.started = monotonic()
        self.log_text = None
        self.workflow_text = None
        self.jobs = []
        self.verified_run = False

    def _request(self, url, headers, max_bytes):
        opener = build_opener(ProxyHandler({}), _NoRedirect)
        try:
            deadline = min(self.started + 120, self.deadline or float("inf"))
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise EvidenceUnavailable("request_budget_exhausted")
            response = opener.open(Request(url, headers=headers), timeout=min(20, remaining))
        except HTTPError as error:
            return error.code, dict(error.headers), b""
        except (OSError, URLError, HTTPException) as error:
            raise EvidenceUnavailable("network_unavailable") from error
        try:
            with response:
                chunks, count = [], 0
                while count <= max_bytes:
                    if monotonic() >= deadline:
                        raise EvidenceUnavailable("request_budget_exhausted")
                    # read1 returns after one underlying read, so a trickling
                    # response cannot hide inside a fill-buffer loop indefinitely.
                    chunk = response.read1(min(65536, max_bytes + 1 - count))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    count += len(chunk)
                body = b"".join(chunks)
                return response.status, dict(response.headers), body
        except (OSError, HTTPException) as error:
            raise EvidenceUnavailable("network_unavailable") from error

    def _bounded_request(self, url, headers):
        if self.requests >= 12 or monotonic() - self.started >= 120 or (self.deadline is not None and monotonic() >= self.deadline):
            raise EvidenceUnavailable("request_budget_exhausted")
        self.requests += 1
        return self.request(url, headers, MAX_DOCUMENT_BYTES)

    def _fetch(self, url, *, authenticated=False, log=False):
        headers = {"Accept": "application/vnd.github+json" if authenticated else "text/plain", "User-Agent": "rocm-readiness-diagnosis"}
        if authenticated:
            parsed = urlparse(url)
            if parsed.scheme != "https" or parsed.netloc != "api.github.com":
                raise EvidenceUnavailable("invalid_api_origin")
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
        status, response_headers, body = self._bounded_request(url, headers)
        if log and status in (301, 302, 303, 307, 308):
            target = next((v for k, v in response_headers.items() if k.lower() == "location"), "")
            parsed = urlparse(target)
            host = parsed.hostname or ""
            if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443)
                    or not (host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com"))):
                raise EvidenceUnavailable("invalid_log_redirect")
            # A fresh request has no Authorization, cookies, or API credentials.
            status, _, body = self._bounded_request(target, {"User-Agent": "rocm-readiness-diagnosis"})
        if status != 200:
            raise EvidenceUnavailable("evidence_unavailable")
        if not isinstance(body, bytes) or len(body) > MAX_DOCUMENT_BYTES:
            raise EvidenceUnavailable("document_too_large")
        return body

    def _json(self, path):
        return json.loads(self._fetch(API + path, authenticated=True))

    def _add(self, key, url, loader, *, count_document=True, max_selected=None):
        if key in self.cache:
            return self.cache[key]
        if (count_document and self.documents >= MAX_DOCUMENTS) or self.bytes >= MAX_EVIDENCE_BYTES:
            raise EvidenceUnavailable("evidence_budget_exhausted")
        if count_document:
            self.documents += 1
        raw = loader()
        if not isinstance(raw, str):
            raw = json.dumps(raw, ensure_ascii=False, sort_keys=True)
        if len(raw.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            raise EvidenceUnavailable("document_too_large")
        safe = redact(raw, self.secrets)
        remaining = min(MAX_EVIDENCE_BYTES - self.bytes, max_selected or MAX_EVIDENCE_BYTES)
        if key == "log-initial" and len(safe.encode("utf-8")) > remaining:
            # Runtime annotations and compiler failures precede setup chatter.
            lines = safe.splitlines()
            failed_steps = [step for job in getattr(self, "jobs", []) if job.get("id") == self.provenance.get("job_id")
                            for step in job.get("steps", []) if step.get("conclusion") == "failure"]
            def failed_step_line(line):
                stamp = line[:19]
                return any(step.get("started_at") and step.get("completed_at")
                           and step["started_at"][:19] <= stamp <= step["completed_at"][:19]
                           for step in failed_steps)
            matches = {j for i, line in enumerate(lines) if re.search(r"##\[error\]|fatal|error:|exception|traceback|failed", line, re.I)
                       for j in range(max(0, i - 2), min(len(lines), i + 4))}
            chunk = max(0, remaining // 4 - 64)
            safe = ("[runtime errors]\n" + _trim("\n".join(lines[i] for i in sorted(matches, key=lambda i: (not failed_step_line(lines[i]), i))), chunk * 2)
                    + "\n[tail]\n" + safe.encode("utf-8")[-chunk:].decode("utf-8", errors="ignore")
                    + "\n[start]\n" + _trim(safe, chunk)) if chunk else ""
        text = _trim(safe, remaining)
        kind = ("workflow" if isinstance(key, tuple) and key[0] == "workflow" else
                "log" if (isinstance(key, tuple) or key == "log-initial") else key)
        item = {"id": f"E{len(self.evidence) + 1}", "text": text, "url": url, "kind": kind}
        if kind == "workflow":
            item["workflow_complete"] = text == safe
            item["workflow_job_names_complete"] = text == safe
        self.bytes += len(text.encode("utf-8"))
        self.evidence.append(item)
        self.cache[key] = item
        return item

    def _identity(self, assessment):
        scope = assessment.get("scope", {})
        repo = scope.get("repository")
        if not isinstance(repo, str) or repo.lower() not in self.allowed:
            raise EvidenceUnavailable("repository_not_allowed")
        metadata = self._json(f"/repos/{repo}")
        if metadata.get("private") is not False or metadata.get("visibility", "public") != "public":
            raise EvidenceUnavailable("repository_not_public")
        self.repo = repo
        supplied = assessment.get("provenance", {})
        self.provenance = {"repository": repo}
        for field in ("run_id", "attempt", "job_id", "revision", "workflow"):
            value = supplied.get(field)
            if value is not None:
                self.provenance[field] = value
        for entry in assessment.get("evidence", []):
            url = entry.get("url", "")
            match = re.fullmatch(r"https://github\.com/" + re.escape(repo) + r"/actions/runs/(\d+)(?:/attempts/(\d+))?(?:/job/(\d+))?", url)
            if match:
                self.provenance.setdefault("run_id", int(match[1]))
                if match[2]:
                    self.provenance.setdefault("attempt", int(match[2]))
                if match[3]:
                    self.provenance.setdefault("job_id", int(match[3]))
        for field in ("run_id", "attempt", "job_id"):
            value = self.provenance.get(field)
            if isinstance(value, str) and re.fullmatch(r"[0-9]{1,20}", value):
                self.provenance[field] = int(value)
            if field in self.provenance and (type(self.provenance[field]) is not int or self.provenance[field] < 1):
                raise EvidenceUnavailable("invalid_provenance")
        if "run_id" in self.provenance:
            run = self._json(f"/repos/{repo}/actions/runs/{self.provenance['run_id']}")
            if run.get("id") != self.provenance["run_id"]:
                raise EvidenceUnavailable("provenance_mismatch")
            # Never substitute the latest attempt for an unknown historical attempt.
            if "attempt" not in self.provenance:
                raise EvidenceUnavailable("attempt_unknown")
            attempt = self._json(f"/repos/{repo}/actions/runs/{run['id']}/attempts/{self.provenance['attempt']}")
            if attempt.get("id") != run["id"] or attempt.get("run_attempt") != self.provenance["attempt"]:
                raise EvidenceUnavailable("provenance_mismatch")
            revision = attempt.get("head_sha")
            if not isinstance(revision, str) or not SHA.fullmatch(revision):
                raise EvidenceUnavailable("revision_unknown")
            if self.provenance.get("revision", revision) != revision:
                raise EvidenceUnavailable("provenance_mismatch")
            self.provenance["revision"] = revision
            self.provenance["workflow"] = attempt.get("path", run.get("path", "")).split("@")[0]
            self.verified_run = True

    def collect(self, assessment):
        self._reset()
        self.assessment = assessment
        if assessment.get("anomaly") == "missing_evidence":
            # A previous build's logs cannot establish why a later build is absent.
            return {"evidence": [], "provenance": {}, "availability": "insufficient",
                    "code": "missing_interval_evidence_unavailable", "incident": {},
                    "run_verified": False}
        try:
            run_error = None
            try:
                self._identity(assessment)
            except (EvidenceUnavailable, ValueError, KeyError, TypeError) as error:
                # A public pinned report remains useful when there is no exact
                # historical run attempt. Never unlock run tools in this case.
                if self.repo is None:
                    raise
                run_error = str(error) if isinstance(error, EvidenceUnavailable) else "invalid_evidence"
            # A missing document must not hide independent workflow/report evidence.
            errors = []
            def attempt(load):
                try:
                    load()
                except (EvidenceUnavailable, ValueError, KeyError, TypeError) as error:
                    errors.append(str(error) if isinstance(error, EvidenceUnavailable) else "invalid_evidence")
            if (assessment.get("report_snapshot") or assessment.get("report_url")
                    or any(e.get("label") == "Qualification report" for e in assessment.get("evidence", []))):
                attempt(self.get_report)
            if self.verified_run:
                attempt(self.get_run_jobs)
                if self.provenance.get("job_id"):
                    attempt(self._initial_log)
                if self.provenance.get("workflow"):
                    attempt(self.get_workflow)
            if errors:
                run_error = errors[0]
            availability = "available" if self.evidence else "insufficient"
            code = ("report_only_run_unavailable" if self.evidence and run_error and not self.verified_run else
                    run_error or ("ok" if self.evidence else "no_evidence"))
            if run_error and not self.evidence:
                availability = "unavailable"
        except (EvidenceUnavailable, ValueError, KeyError, TypeError) as error:
            availability, code = "unavailable", str(error) if isinstance(error, EvidenceUnavailable) else "invalid_evidence"
        package = {"evidence": list(self.evidence), "provenance": dict(self.provenance), "availability": availability, "code": code,
                "run_verified": self.verified_run,
                "incident": json.loads(redact(json.dumps({key: assessment[key] for key in ("scope", "observed", "summary", "anomaly") if key in assessment}), self.secrets)),
                "evidence_hash": hashlib.sha256(json.dumps(self.evidence, sort_keys=True).encode()).hexdigest()}
        if self.verified_run and assessment.get("observed", {}).get("status") in ("skip", "skipped"):
            try:
                if __package__:
                    from .diagnosis_support import workflow_jobs
                else:
                    from diagnosis_support import workflow_jobs
                definitions = workflow_jobs(self.workflow_text or "") or {}
                target = next((job for job in self.jobs if job.get("id") == self.provenance.get("job_id")), {})
                name = target.get("name", "")
                candidates = [key for key, data in definitions.items()
                              if name == (data.get("name") or key).strip("'\"")
                              or ("name" not in data and name.startswith(key + " (") and name.endswith(")"))]
                if len(candidates) == 1:
                    self.get_workflow(job=candidates[0], max_lines=400)
            except (EvidenceUnavailable, ValueError, KeyError, TypeError):
                pass
        diagnosis = self._known_runtime_diagnosis(assessment)
        if diagnosis is not None:
            package["diagnosis"] = diagnosis
        package["evidence"] = list(self.evidence)
        package["evidence_hash"] = hashlib.sha256(json.dumps(self.evidence, sort_keys=True).encode()).hexdigest()
        return package

    def _known_runtime_diagnosis(self, assessment):
        """Explain a literal recorded build error before asking a language model.

        Match only selected runtime log evidence, not workflow source or an
        unselected region of the cached full log. Do not infer why PATH lacks it.
        """
        if self.verified_run and assessment.get("observed", {}).get("status") in ("skip", "skipped"):
            if __package__:
                from .diagnosis_support import supported_skip_cause
            else:
                from diagnosis_support import supported_skip_cause
            ids = [row["id"] for row in self.evidence if row.get("kind") == "jobs"
                   or (row.get("kind") == "workflow" and row.get("workflow_complete") is True)]
            cause = supported_skip_cause(self.evidence, assessment, self.provenance, ids)
            if cause is not None:
                return {"method": "deterministic", "certainty": "verified", "cause": cause, "evidence_ids": ids}
        if not self.verified_run or assessment.get("observed", {}).get("status") not in ("fail", "failure"):
            return None
        if not any(job.get("id") == self.provenance.get("job_id") and job.get("conclusion") == "failure"
                   for job in getattr(self, "jobs", [])):
            return None
        diagnostic = re.compile(
            r"(?:\d{4}-\d{2}-\d{2}T\S+\s+)?"
            r"lld-link: error: unable to find mt\.exe in PATH: no such file or directory"
        )
        for row in self.evidence:
            if row.get("kind") != "log" or row.get("url") != self._log_url():
                continue
            if any(diagnostic.fullmatch(line.strip()) for line in row.get("text", "").splitlines()):
                return {"method": "deterministic", "certainty": "verified",
                        "cause": "A required build tool could not be located by the job.",
                        "evidence_ids": [row["id"]]}
        return None


    def get_run_jobs(self):
        if not self.verified_run:
            raise EvidenceUnavailable("run_not_verified")
        run, attempt = self.provenance["run_id"], self.provenance["attempt"]
        url = f"https://github.com/{self.repo}/actions/runs/{run}/attempts/{attempt}"
        def load():
            result = self._json(f"/repos/{self.repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100")
            jobs = result.get("jobs", [])
            if result.get("total_count", len(jobs)) > len(jobs):
                raise EvidenceUnavailable("jobs_incomplete")
            for job in jobs:
                if job.get("run_id") != run or job.get("run_attempt") != attempt:
                    raise EvidenceUnavailable("provenance_mismatch")
            if self.provenance.get("job_id") and not any(job.get("id") == self.provenance["job_id"] for job in jobs):
                raise EvidenceUnavailable("job_not_in_attempt")
            self.jobs = jobs
            # Job API envelopes contain large amounts of runner/URL boilerplate.
            # Preserve all exact-attempt outcomes and failed steps for reasoning.
            return {"run_id": run, "attempt": attempt, "jobs": [
                {"id": job.get("id"), "name": job.get("name"),
                 "status": job.get("status"), "conclusion": job.get("conclusion"),
                 "failed_steps": [step.get("name") for step in job.get("steps", [])
                                  if step.get("conclusion") == "failure"]}
                for job in jobs
            ]}
        return self._add("jobs", url, load)

    def _load_log(self):
        if self.log_text is None:
            self.get_run_jobs()
            if self.documents >= MAX_DOCUMENTS:
                raise EvidenceUnavailable("evidence_budget_exhausted")
            self.documents += 1
            job = self.provenance["job_id"]
            raw = self._fetch(f"{API}/repos/{self.repo}/actions/jobs/{job}/logs", authenticated=True, log=True)
            lines = redact(raw.decode("utf-8", errors="replace"), self.secrets).splitlines()
            retained, echo = [], False
            for line in lines:
                if re.match(r"(?:\d{4}-\d{2}-\d{2}T\S+\s+)?##\[group\]Run(?:\s|$)", line):
                    echo = True
                elif echo and re.match(r"(?:\d{4}-\d{2}-\d{2}T\S+\s+)?##\[endgroup\]", line):
                    echo = False
                elif not echo:
                    retained.append(line)
            self.log_text = "\n".join(retained)
        return self.log_text

    def _log_url(self):
        return f"https://github.com/{self.repo}/actions/runs/{self.provenance['run_id']}/job/{self.provenance['job_id']}"

    def _initial_log(self):
        return self._add("log-initial", self._log_url(), self._load_log,
                         count_document=False, max_selected=16 * 1024)

    def get_job_log(self, start_line=1, max_lines=200):
        if type(start_line) is not int or start_line < 1 or type(max_lines) is not int or not 1 <= max_lines <= 400:
            raise EvidenceUnavailable("invalid_log_range")
        lines = self._load_log().splitlines()
        return self._add(("log-page", start_line, max_lines), self._log_url(),
                         lambda: "\n".join(lines[start_line - 1:start_line - 1 + max_lines]),
                         count_document=False, max_selected=8192)

    def search_job_log(self, query):
        if not isinstance(query, str) or not query or len(query) > 200:
            raise EvidenceUnavailable("invalid_search")
        lines = self._load_log().splitlines()
        positions = {j for i, line in enumerate(lines) if query.lower() in line.lower() for j in range(max(0, i - 2), min(len(lines), i + 3))}
        return self._add(("log-search", query.lower()), self._log_url(),
                         lambda: "\n".join(lines[i] for i in sorted(positions)),
                         count_document=False, max_selected=8192)

    def get_workflow(self, job=None, start_line=None, max_lines=200):
        if not self.verified_run:
            raise EvidenceUnavailable("run_not_verified")
        path, revision = self.provenance["workflow"], self.provenance["revision"]
        if not isinstance(path, str) or not re.fullmatch(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml", path):
            raise EvidenceUnavailable("invalid_workflow_path")
        url = f"https://github.com/{self.repo}/blob/{revision}/{path}"
        if job is not None and (not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job)):
            raise EvidenceUnavailable("invalid_workflow_job")
        if (start_line is not None and (type(start_line) is not int or start_line < 1)) or type(max_lines) is not int or not 1 <= max_lines <= 400:
            raise EvidenceUnavailable("invalid_workflow_range")
        if job is not None and start_line is not None:
            raise EvidenceUnavailable("invalid_workflow_range")
        selection_complete = True
        def load():
            nonlocal selection_complete
            if self.workflow_text is None:
                data = self._json(f"/repos/{self.repo}/contents/{quote(path, safe='/')}?ref={revision}")
                if data.get("encoding") != "base64":
                    raise EvidenceUnavailable("workflow_unavailable")
                self.workflow_text = base64.b64decode(data["content"]).decode("utf-8")
            lines = self.workflow_text.splitlines()
            if job is not None:
                if __package__:
                    from .diagnosis_support import workflow_jobs, _needs
                else:
                    from diagnosis_support import workflow_jobs, _needs
                definitions = workflow_jobs(self.workflow_text)
                if not definitions or job not in definitions:
                    raise EvidenceUnavailable("workflow_job_unavailable")
                names = [job] + (_needs(definitions[job].get("needs", "")) or [])
                blocks = []
                for name in dict.fromkeys(names + list(definitions)):
                    definition = definitions.get(name)
                    if definition is None:
                        selection_complete = False
                        continue
                    # Parse the whole immutable document before projecting every
                    # job-level field relevant to dependency gating. Step bodies
                    # cannot consume the budget or conceal a later job-level if.
                    blocks.append("  " + name + ":")
                    for field in (("name", "needs", "if", "continue-on-error", "strategy") if name in names else ("name", "strategy")):
                        if field not in definition:
                            continue
                        values = definition[field].split("\n")
                        blocks.append("    " + field + ": " + values[0])
                        blocks.extend(values[1:] if field == "strategy" else ("      " + value for value in values[1:]))
                selected = ["jobs:"] + blocks
                selection_complete = selection_complete and len(selected) <= max_lines
                return "\n".join(selected[:max_lines])
            if start_line is not None:
                selection_complete = start_line == 1 and len(lines) <= max_lines
                return "\n".join(lines[start_line - 1:start_line - 1 + max_lines])
            return self.workflow_text
        key = "workflow" if job is None and start_line is None else ("workflow", job, start_line, max_lines)
        # Reserve space for tool-selected late job blocks and log excerpts.
        item = self._add(key, url, load, count_document=self.workflow_text is None, max_selected=8192)
        item["workflow_complete"] = item.get("workflow_complete", False) and selection_complete
        item["workflow_job_names_complete"] = item.get("workflow_job_names_complete", False) and selection_complete
        return item

    def get_report(self):
        if self.repo is None:
            raise EvidenceUnavailable("repository_not_authorized")
        snapshot = self.assessment.get("report_snapshot", {})
        url = snapshot.get("source_url") or self.assessment.get("report_url") or next((e["url"] for e in self.assessment.get("evidence", []) if e.get("label") == "Qualification report"), "")
        match = re.fullmatch(r"https://raw\.githubusercontent\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/([a-f0-9]{40})/qualification/reports/([A-Za-z0-9_.-]+\.json)", url)
        if not match or match[1].lower() != self.repo.lower():
            raise EvidenceUnavailable("report_not_pinned")
        def load():
            if isinstance(snapshot.get("report"), dict):
                return snapshot["report"]
            return self._fetch(url).decode("utf-8")
        return self._add("report", url, load)

    def call_tool(self, name, arguments=None):
        arguments = arguments or {}
        if not isinstance(arguments, dict):
            return {"error": "invalid_arguments"}
        methods = {"get_job_log": self.get_job_log, "get_run_jobs": self.get_run_jobs, "get_workflow": self.get_workflow, "get_report": self.get_report, "search_job_log": self.search_job_log}
        if name not in methods or set(arguments) - ({"query"} if name == "search_job_log" else {"start_line", "max_lines"} if name == "get_job_log" else {"job", "start_line", "max_lines"} if name == "get_workflow" else set()):
            return {"error": "tool_not_allowed"}
        try:
            return methods[name](**arguments)
        except (EvidenceUnavailable, ValueError, KeyError, TypeError):
            return {"error": "evidence_unavailable"}

    def tools(self):
        """Incident-bound callables for an OpenAI-compatible tool loop."""
        return {name: (lambda _name=name, **kwargs: self.call_tool(_name, kwargs)) for name in (
            "get_job_log", "search_job_log", "get_workflow", "get_run_jobs", "get_report",
        )}

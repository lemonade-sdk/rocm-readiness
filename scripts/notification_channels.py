"""Secret-backed GitHub routing and an injectable, acceptance-only transport.

The lifecycle caller owns persistence, concurrency, retries and trusted-run gating.
No configuration, credential, recipient, or provider response is logged here.
"""

from dataclasses import dataclass, field
import hashlib
from http.client import HTTPException
import json
import re
import urllib.error
import urllib.request


class ConfigurationError(ValueError):
    """A configuration error whose message never contains supplied values."""


@dataclass(frozen=True)
class ChannelConfig:
    enabled: bool = False
    targets: tuple[str, ...] = field(default=(), repr=False)
    scopes: tuple[str, ...] = ()
    available: bool = True


@dataclass(frozen=True)
class NotificationConfig:
    github: ChannelConfig
    available: bool = True

    def for_channel(self, name, scope):
        if name != "github":
            raise ValueError("unknown notification channel")
        channel = self.github
        if channel.scopes and scope not in channel.scopes:
            return ChannelConfig(available=channel.available)
        return channel


_SLUG = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
_TARGET = re.compile(rf"{_SLUG}(?:/{_SLUG})?")
_SCOPE = re.compile(r"[a-z0-9][a-z0-9-]*")
_REPOSITORY = re.compile(rf"{_SLUG}/[A-Za-z0-9_.-]+")
_ROUTING_MARKER = "<!-- rocm-readiness-initial-routing -->"
MAX_LOOKUP_PAGES = 100


def has_initial_routing(issue):
    """Confirm a unique routing marker immediately precedes actual mentions."""
    body = issue.get("body") if isinstance(issue, dict) else None
    if not isinstance(body, str):
        return False
    lines = body.splitlines()
    if lines.count(_ROUTING_MARKER) != 1:
        return False
    following = lines[lines.index(_ROUTING_MARKER) + 1:]
    first_line = next((line.strip() for line in following if line.strip()), "")
    return any(
        entry.startswith("@") and _TARGET.fullmatch(entry[1:])
        for entry in first_line.split()
    )


def _invalid():
    raise ConfigurationError("invalid notification configuration")


def _unique(values, pattern):
    if not isinstance(values, list):
        _invalid()
    result = []
    seen = set()
    for value in values:
        if not isinstance(value, str) or not pattern.fullmatch(value):
            _invalid()
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return tuple(result)


def parse_notification_config(raw, *, known_scopes=None):
    """Parse ROCM_READINESS_NOTIFICATION_LIST; absence is unavailable, not sent.

    Enabled routing requires targets. Omitted scopes mean all sources; an
    explicitly empty scopes list is invalid. Legacy disabled-email/empty-assignee
    fields are accepted so the provisioned GitHub-only secret remains valid.
    """
    if raw is None:
        unavailable = ChannelConfig(available=False)
        return NotificationConfig(unavailable, available=False)
    if not isinstance(raw, str) or not raw.strip():
        _invalid()

    def no_duplicate_keys(pairs):
        value = {}
        for key, entry in pairs:
            if key in value:
                _invalid()
            value[key] = entry
        return value

    try:
        data = json.loads(raw, object_pairs_hook=no_duplicate_keys)
    except (ValueError, TypeError, RecursionError):
        raise ConfigurationError("invalid notification configuration") from None
    if (
        not isinstance(data, dict)
        or not {"schema_version", "github"} <= set(data)
        or set(data) - {"schema_version", "github", "email"}
        or type(data["schema_version"]) is not int
        or data["schema_version"] != 1
    ):
        _invalid()
    if "email" in data:
        email = data["email"]
        if (
            not isinstance(email, dict) or set(email) != {"enabled", "recipients"}
            or email["enabled"] is not False or email["recipients"] != []
        ):
            _invalid()
    item = data["github"]
    if (
        not isinstance(item, dict) or not {"targets", "enabled"} <= set(item)
        or set(item) - {"targets", "enabled", "scopes", "assignees"}
        or type(item["enabled"]) is not bool or item.get("assignees", []) != []
    ):
        _invalid()
    targets = _unique(item["targets"], _TARGET)
    if item["enabled"] and not targets:
        _invalid()
    scopes = _unique(item["scopes"], _SCOPE) if "scopes" in item else ()
    if "scopes" in item and not scopes:
        _invalid()
    if known_scopes is not None and not set(scopes) <= set(known_scopes):
        _invalid()
    return NotificationConfig(ChannelConfig(item["enabled"], targets, scopes))


@dataclass(frozen=True)
class Notification:
    incident_id: str
    summary: str
    scope: str
    reason: str = "unknown"
    details: str = ""
    labels: tuple[str, ...] = ()


@dataclass(frozen=True)
class DispatchResult:
    status: str
    issue_url: str | None = None
    external_id: str | None = None
    code: str | None = None

    @property
    def accepted(self):
        return self.status == "accepted"


class ApiError(Exception):
    def __init__(self, *, ambiguous=False, status=None):
        super().__init__("notification API request failed")
        self.ambiguous = ambiguous
        self.status = status


_IO_ERRORS = (OSError, HTTPException, UnicodeError, json.JSONDecodeError)
_API_ERRORS = (ApiError,) + _IO_ERRORS


class JsonAPI:
    """Fixed-origin stdlib JSON API. Redirects cannot forward secret headers."""

    def __init__(self, origin, credential, *, timeout=20):
        self._origin = origin
        self._credential = credential
        self._timeout = timeout

    def __repr__(self):
        return "JsonAPI(<redacted>)"

    def request(self, method, path, payload=None, headers=None):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, response_headers, newurl):
                return None

        request = urllib.request.Request(
            self._origin + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={
                "Authorization": "Bearer " + self._credential,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "rocm-readiness-notifications",
                **(headers or {}),
            },
            method=method,
        )
        try:
            with urllib.request.build_opener(NoRedirect()).open(
                request, timeout=self._timeout
            ) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ApiError(
                ambiguous=error.code >= 500 or error.code in (408, 409),
                status=error.code,
            ) from None
        except _IO_ERRORS:
            # A timeout, malformed success response, or broken connection may
            # follow a committed send. Never blindly treat these as rejection.
            raise ApiError(ambiguous=True) from None


def incident_marker(incident_id):
    digest = hashlib.sha256(incident_id.encode()).hexdigest()
    return f"<!-- rocm-readiness-incident:{digest} -->"


def _content(notification):
    return (
        f"## What happened\n\n{notification.reason or 'Investigation required.'}\n\n"
        f"{notification.details}"
    ).strip()


def _gate(channel, notification, dry_run):
    if not channel.available:
        return DispatchResult("unavailable", code="configuration_missing")
    if not channel.enabled or (
        channel.scopes and notification.scope not in channel.scopes
    ):
        return DispatchResult("disabled")
    if not channel.targets:
        return DispatchResult("unavailable", code="recipients_missing")
    if dry_run:
        return DispatchResult("dry_run")
    return None


class GitHubTransport:
    def __init__(self, repository, token=None, *, api=None):
        if (
            not isinstance(repository, str)
            or not _REPOSITORY.fullmatch(repository)
            or repository.split("/")[1] in (".", "..")
        ):
            raise ValueError("invalid notification repository")
        self.repository = repository
        self._api = api or (JsonAPI("https://api.github.com", token) if token else None)
        self._path = f"/repos/{repository}/issues"

    def __repr__(self):
        return f"GitHubTransport(repository={self.repository!r})"

    def _checked(self, issue):
        if not isinstance(issue, dict):
            raise ApiError(ambiguous=True)
        number = issue.get("number")
        url = issue.get("html_url")
        labels = issue.get("labels", [])
        if (
            type(number) is not int
            or number < 1
            or url != f"https://github.com/{self.repository}/issues/{number}"
            or issue.get("state") not in ("open", "closed")
            or not isinstance(issue.get("body"), str)
            or not isinstance(labels, list)
            or any(
                not (
                    isinstance(label, str)
                    or isinstance(label, dict) and isinstance(label.get("name"), str)
                )
                for label in labels
            )
        ):
            raise ApiError(ambiguous=True)
        return issue

    def lookup(self, incident_id):
        """Read every issue state/page; never use search indexing or titles."""
        if self._api is None:
            raise ApiError()
        marker = incident_marker(incident_id)
        found = None
        for page in range(1, MAX_LOOKUP_PAGES + 1):
            issues = self._api.request(
                "GET", f"{self._path}?state=all&per_page=100&page={page}"
            )
            if not isinstance(issues, list):
                raise ApiError(ambiguous=True)
            for issue in issues:
                if not isinstance(issue, dict):
                    raise ApiError(ambiguous=True)
                body = issue.get("body") or ""
                if not isinstance(body, str):
                    raise ApiError(ambiguous=True)
                if (
                    not issue.get("pull_request")
                    and marker in body.splitlines()
                ):
                    if found is not None:
                        raise ApiError(ambiguous=True)
                    found = self._checked(issue)
            if len(issues) < 100:
                return found
        # A full final page cannot establish an exhaustive marker lookup.
        raise ApiError(ambiguous=True)

    def deliver(self, notification, channel, *, dry_run=False):
        gated = _gate(channel, notification, dry_run)
        if gated:
            return gated
        if self._api is None:
            return DispatchResult("unavailable", code="github_credentials_missing")
        marker = incident_marker(notification.incident_id)
        try:
            existing = self.lookup(notification.incident_id)
        except _API_ERRORS:
            return DispatchResult("ambiguous", code="github_lookup_failed")
        routing_marker = _ROUTING_MARKER
        body = f"{marker}\n\n{_content(notification)}"
        if existing:
            if not has_initial_routing(existing):
                return DispatchResult("ambiguous", code="github_routing_unknown")
            # Preserve the original routing, even after recipient-list changes.
            previous = existing["body"]
            if routing_marker in previous:
                body += "\n\n" + routing_marker + previous.split(routing_marker, 1)[1]
            method, path = "PATCH", f"{self._path}/{existing['number']}"
            payload = {
                "state": "open",
                "title": notification.summary[:240],
                "body": body,
                "labels": self._labels(existing, notification.labels),
            }
            if (
                all(
                    existing.get(key) == value
                    for key, value in payload.items()
                    if key != "labels"
                )
                and set(payload["labels"]) <= {
                    label["name"] if isinstance(label, dict) else label
                    for label in existing.get("labels", [])
                }
            ):
                return self._accepted(existing)
        else:
            body += "\n\n" + routing_marker + "\n" + " ".join(
                "@" + target for target in channel.targets
            )
            method, path = "POST", self._path
            payload = {
                "title": notification.summary[:240],
                "body": body,
                "labels": self._labels({}, notification.labels),
            }
        if not has_initial_routing(payload):
            return DispatchResult("rejected", code="github_invalid_routing")
        try:
            issue = self._checked(self._api.request(method, path, payload))
            if issue["body"] != body or issue["state"] != "open":
                raise ApiError(ambiguous=True)
            return self._accepted(issue)
        except _API_ERRORS as error:
            if isinstance(error, ApiError) and not error.ambiguous:
                return DispatchResult("rejected", code="github_rejected")
            # POST/PATCH might have committed before its response was lost.
            try:
                issue = self.lookup(notification.incident_id)
                if issue and issue["state"] == "open" and issue["body"] == body:
                    return self._accepted(issue)
            except _API_ERRORS:
                pass
            return DispatchResult("ambiguous", code="github_response_unknown")

    @staticmethod
    def _labels(issue, extra=()):
        labels = [
            label["name"] if isinstance(label, dict) else label
            for label in issue.get("labels", [])
        ]
        return list(dict.fromkeys(labels + ["bug", "upstream-incident"] + list(extra)))

    @staticmethod
    def _accepted(issue):
        return DispatchResult(
            "accepted", issue_url=issue["html_url"], external_id=str(issue["number"])
        )

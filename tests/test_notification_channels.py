import copy
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from scripts.notification_channels import (
    ApiError,
    ChannelConfig,
    ConfigurationError,
    GitHubTransport,
    JsonAPI,
    Notification,
    has_initial_routing,
    incident_marker,
    parse_notification_config,
)


def configuration():
    return {
        "schema_version": 1,
        "github": {"enabled": True, "targets": ["fixture-owner", "fixture-org/team"]},
        "email": {"enabled": False, "recipients": []},
    }


def notice(**kwargs):
    values = {
        "incident_id": "stable-incident",
        "summary": "Nightly regression",
        "scope": "fixture-source",
        "reason": "unknown",
        "details": "Job: fixture-job\nDate: 2026-11-17",
    }
    return Notification(**(values | kwargs))


def issue(number=1, **kwargs):
    values = {
        "number": number,
        "html_url": f"https://github.com/fixture/repository/issues/{number}",
        "state": "open",
        "title": "Nightly regression",
        "body": "",
        "labels": ["bug", "upstream-incident"],
    }
    return values | kwargs


class FakeGitHub:
    def __init__(self, issues=(), failure=None):
        self.issues = copy.deepcopy(list(issues))
        self.calls = []
        self.failure = failure

    def request(self, method, path, payload=None, headers=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        if method == "GET":
            page = int(path.rsplit("=", 1)[1])
            return copy.deepcopy(self.issues[(page - 1) * 100:page * 100])
        if self.failure == "rejected":
            raise ApiError(status=403)
        if self.failure == "unknown":
            raise OSError("private-one@example.test secret-token")
        if method == "POST":
            created = issue(len(self.issues) + 1, **payload)
            self.issues.append(created)
        else:
            number = int(path.rsplit("/", 1)[1])
            created = next(item for item in self.issues if item["number"] == number)
            created.update(payload)
        if self.failure == "lost_response":
            raise ApiError(ambiguous=True)
        return copy.deepcopy(created)


class ConfigurationTests(unittest.TestCase):
    def test_github_only_and_provisioned_disabled_fields_are_supported(self):
        data = configuration()
        data["github"]["assignees"] = []
        provisioned = parse_notification_config(json.dumps(data))
        data.pop("email")
        data["github"].pop("assignees")
        self.assertEqual(parse_notification_config(json.dumps(data)), provisioned)

    def test_missing_is_unavailable_not_success(self):
        config = parse_notification_config(None)
        self.assertFalse(config.available)
        self.assertFalse(config.github.available)
        result = GitHubTransport("fixture/repository").deliver(notice(), config.github)
        self.assertEqual(result.status, "unavailable")
        self.assertFalse(result.accepted)

    def test_deduplicates_targets_and_scopes_without_exposure(self):
        data = configuration()
        data["github"]["targets"] += ["FIXTURE-OWNER", "fixture-org/team"]
        data["github"]["scopes"] = ["fixture-source", "fixture-source"]
        config = parse_notification_config(json.dumps(data), known_scopes=["fixture-source"])
        self.assertEqual(len(config.github.targets), 2)
        self.assertEqual(config.github.scopes, ("fixture-source",))
        for secret in data["github"]["targets"]:
            self.assertNotIn(secret, repr(config))

    def test_strict_schema_and_private_errors(self):
        variants = [
            "", " ", "[]", "{}", "null", "{private-one@example.test",
            '{"schema_version":1,"schema_version":1}',
        ]
        changes = [
            ("schema_version", True), ("schema_version", 2),
            ("github", None), ("email", []),
        ]
        for key, value in changes:
            data = configuration()
            data[key] = value
            variants.append(json.dumps(data))
        for channel, field, value in [
            ("github", "enabled", 1),
            ("github", "targets", []),
            ("github", "targets", ["@fixture-owner"]),
            ("github", "targets", ["other/repository/issue"]),
            ("github", "targets", ["bad\n@target"]),
            ("github", "targets", [" fixture-owner"]),
            ("github", "targets", [42]),
            ("github", "scopes", []),
            ("github", "scopes", ["unknown"]),
            ("github", "assignees", ["fixture-owner"]),
            ("email", "assignees", ["fixture-owner"]),
            ("email", "enabled", True),
            ("email", "recipients", ["private-one@example.test"]),
            ("email", "extra", "private-one@example.test"),
        ]:
            data = configuration()
            data[channel][field] = value
            variants.append(json.dumps(data))
        data = configuration()
        data["private-one@example.test"] = True
        variants.append(json.dumps(data))
        for raw in variants:
            with self.subTest(raw=raw):
                with self.assertRaises(ConfigurationError) as caught:
                    parse_notification_config(raw, known_scopes=["fixture-source"])
                self.assertEqual(str(caught.exception), "invalid notification configuration")
                self.assertNotIn("private-one", repr(caught.exception))

    def test_disabled_empty_lists_and_scoped_routing(self):
        data = configuration()
        data["github"] = {"enabled": False, "targets": []}
        config = parse_notification_config(json.dumps(data))
        self.assertFalse(config.for_channel("github", "fixture-source").enabled)
        data["github"] = {"enabled": True, "targets": ["fixture-owner"], "scopes": ["fixture-source"]}
        config = parse_notification_config(json.dumps(data))
        self.assertFalse(config.for_channel("github", "other-source").enabled)
        self.assertTrue(config.for_channel("github", "fixture-source").enabled)


class GitHubTests(unittest.TestCase):
    def setUp(self):
        self.channel = parse_notification_config(json.dumps(configuration())).github

    def test_create_atomic_routing_labels_and_idempotent_update(self):
        api = FakeGitHub()
        transport = GitHubTransport("fixture/repository", api=api)
        result = transport.deliver(notice(), self.channel)
        self.assertEqual(result.status, "accepted")
        self.assertEqual(result.issue_url, "https://github.com/fixture/repository/issues/1")
        created = api.issues[0]
        self.assertEqual(created["labels"], ["bug", "upstream-incident"])
        self.assertEqual(created["body"].count("@fixture-owner"), 1)
        self.assertEqual(created["body"].count("@fixture-org/team"), 1)
        self.assertIn(incident_marker("stable-incident"), created["body"])
        self.assertIn("## What happened", created["body"])
        self.assertIn("## What happened\n\nunknown", created["body"])
        self.assertTrue(transport.deliver(notice(), self.channel).accepted)
        self.assertEqual([call[0] for call in api.calls].count("POST"), 1)
        self.assertNotIn("PATCH", [call[0] for call in api.calls])

    def test_upstream_engine_labels_and_four_mentions_with_no_assignment(self):
        data = configuration()
        data["github"]["targets"] = [
            "fixture-owner", "fixture-reviewer", "fixture-maintainer", "fixture-triager",
        ]
        data["github"]["assignees"] = []
        data["email"] = {"enabled": False, "recipients": []}
        config = parse_notification_config(json.dumps(data))
        api = FakeGitHub()
        transport = GitHubTransport("fixture/repository", api=api)
        message = notice(labels=("engine:llamacpp",))
        self.assertTrue(transport.deliver(message, config.github).accepted)
        created = api.issues[0]
        self.assertEqual(created["labels"], ["bug", "upstream-incident", "engine:llamacpp"])
        self.assertNotIn("assignees", created)
        for target in config.github.targets:
            self.assertEqual(created["body"].count("@" + target), 1)
        created["labels"] = ["bug", "impact-high"]
        self.assertTrue(transport.deliver(message, config.github).accepted)
        self.assertEqual(
            created["labels"], ["bug", "impact-high", "upstream-incident", "engine:llamacpp"],
        )
        self.assertNotIn("assignees", api.calls[-1][2])
        self.assertTrue(transport.deliver(message, config.github).accepted)
        self.assertEqual(sum(call[0] == "PATCH" for call in api.calls), 1)

    def test_lookup_closed_paginated_body_marker_not_title_or_search(self):
        marker = incident_marker("stable-incident")
        api = FakeGitHub(
            [issue(n, title=marker) for n in range(1, 101)]
            + [issue(101, state="closed", body=marker)]
        )
        found = GitHubTransport("fixture/repository", api=api).lookup("stable-incident")
        self.assertEqual(found["number"], 101)
        self.assertEqual(len(api.calls), 2)
        self.assertTrue(all("?state=all&per_page=100&page=" in call[1] for call in api.calls))
        self.assertTrue(all("/search/" not in call[1] for call in api.calls))

    def test_lookup_excludes_pull_requests_and_substring_markers(self):
        marker = incident_marker("stable-incident")
        api = FakeGitHub([
            issue(1, body=marker, pull_request={"url": "fixture"}),
            issue(2, body="quoted " + marker),
        ])
        self.assertIsNone(GitHubTransport("fixture/repository", api=api).lookup("stable-incident"))

    def test_closed_reopen_preserves_original_mentions_and_impact_labels(self):
        api = FakeGitHub()
        transport = GitHubTransport("fixture/repository", api=api)
        transport.deliver(notice(), self.channel)
        api.issues[0]["state"] = "closed"
        api.issues[0]["labels"] += ["impact-high"]
        api.issues[0]["assignees"] = [{"login": "fixture-investigator"}]
        result = transport.deliver(
            notice(reason="build failed"),
            ChannelConfig(True, ("new-owner",)),
        )
        self.assertTrue(result.accepted)
        self.assertEqual(api.issues[0]["state"], "open")
        self.assertIn("impact-high", api.issues[0]["labels"])
        self.assertEqual(api.issues[0]["body"].count("@fixture-owner"), 1)
        self.assertNotIn("@new-owner", api.issues[0]["body"])
        self.assertEqual(sum(call[0] == "POST" for call in api.calls), 1)
        self.assertNotIn("assignees", api.calls[-1][2])
        self.assertEqual(api.issues[0]["assignees"], [{"login": "fixture-investigator"}])

    def test_restores_required_labels_on_existing_incident(self):
        api = FakeGitHub()
        transport = GitHubTransport("fixture/repository", api=api)
        transport.deliver(notice(), self.channel)
        api.issues[0]["labels"] = ["impact-low"]
        self.assertTrue(transport.deliver(notice(), self.channel).accepted)
        self.assertEqual(api.issues[0]["labels"], ["impact-low", "bug", "upstream-incident"])

    def test_lost_create_and_reopen_response_reconcile_without_duplicate(self):
        api = FakeGitHub(failure="lost_response")
        transport = GitHubTransport("fixture/repository", api=api)
        self.assertTrue(transport.deliver(notice(), self.channel).accepted)
        api.issues[0]["state"] = "closed"
        self.assertTrue(transport.deliver(notice(), self.channel).accepted)
        self.assertEqual(len(api.issues), 1)
        self.assertEqual(api.issues[0]["body"].count("@fixture-owner"), 1)

    def test_rejected_and_ambiguous_are_distinct_and_sanitized(self):
        for failure, status in [("rejected", "rejected"), ("unknown", "ambiguous")]:
            with self.subTest(failure=failure):
                api = FakeGitHub(failure=failure)
                result = GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)
                self.assertEqual(result.status, status)
                self.assertNotIn("private-one", repr(result))
                self.assertNotIn("secret-token", repr(result))
                self.assertFalse(result.accepted)
                self.assertEqual(sum(call[0] == "POST" for call in api.calls), 1)

    def test_duplicate_identity_and_cross_repository_fail_closed(self):
        marker = incident_marker("stable-incident")
        for issues in [
            [issue(1, body=marker), issue(2, body=marker)],
            [issue(1, body=marker, html_url="https://github.com/other/repo/issues/1")],
        ]:
            api = FakeGitHub(issues)
            result = GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)
            self.assertEqual(result.status, "ambiguous")
            self.assertTrue(all(call[0] == "GET" for call in api.calls))
        for repository in ["other/repo/../../repo", "fixture/..", "https://github.com/other/repo"]:
            with self.assertRaises(ValueError):
                GitHubTransport(repository)

    def test_dry_run_disabled_unavailable_never_call_api(self):
        api = FakeGitHub()
        transport = GitHubTransport("fixture/repository", api=api)
        self.assertEqual(transport.deliver(notice(), self.channel, dry_run=True).status, "dry_run")
        self.assertEqual(transport.deliver(notice(), ChannelConfig()).status, "disabled")
        self.assertEqual(
            transport.deliver(notice(), ChannelConfig(available=False)).status, "unavailable"
        )
        self.assertEqual(api.calls, [])

    def test_programming_errors_are_not_swallowed_during_lookup_or_write(self):
        for operation in ("GET", "POST"):
            api = FakeGitHub()
            request = api.request

            def failing(method, path, payload=None, headers=None):
                if method == operation:
                    raise RuntimeError("programming defect")
                return request(method, path, payload, headers)

            api.request = failing
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(RuntimeError, "programming defect"):
                    GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)

    def test_malformed_protocol_responses_are_ambiguous(self):
        api = FakeGitHub([issue(body={"invalid": "body"})])
        result = GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)
        self.assertEqual(result.status, "ambiguous")
        self.assertEqual(len(api.calls), 1)

    def test_existing_unrouted_issue_requires_manual_reconciliation(self):
        marker = incident_marker("stable-incident")
        for suffix in (
            "",
            "\n\n<!-- rocm-readiness-initial-routing -->",
            "\n\n<!-- rocm-readiness-initial-routing -->\nnot a mention",
            "\n\n<!-- rocm-readiness-initial-routing -->\n@invalid/target/path",
        ):
            for state in ("open", "closed"):
                with self.subTest(suffix=suffix, state=state):
                    api = FakeGitHub([issue(body=marker + suffix, state=state)])
                    result = GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)
                    self.assertEqual(result.status, "ambiguous")
                    self.assertEqual(result.code, "github_routing_unknown")
                    self.assertFalse(result.accepted)
                    self.assertEqual([call[0] for call in api.calls], ["GET"])
                    self.assertEqual(api.issues[0]["state"], state)

    def test_real_route_validation_preserves_original_audience(self):
        self.assertTrue(has_initial_routing(issue(body=
            "<!-- rocm-readiness-initial-routing -->\n@original-org/maintainers"
        )))
        self.assertFalse(has_initial_routing(issue(body=
            "<!-- rocm-readiness-initial-routing -->\n@bad\n"
            "<!-- rocm-readiness-initial-routing -->\n@fixture-owner"
        )))
        self.assertFalse(has_initial_routing(None))

    def test_full_lookup_page_limit_fails_ambiguous_without_write(self):
        api = FakeGitHub([issue(n) for n in range(1, 201)])
        with patch("scripts.notification_channels.MAX_LOOKUP_PAGES", 2):
            result = GitHubTransport("fixture/repository", api=api).deliver(notice(), self.channel)
        self.assertEqual(result.status, "ambiguous")
        self.assertEqual(result.code, "github_lookup_failed")
        self.assertEqual(len(api.calls), 2)
        self.assertTrue(all(call[0] == "GET" for call in api.calls))


class HttpTests(unittest.TestCase):
    def test_stdlib_request_and_no_redirect_handler(self):
        api = JsonAPI("https://api.github.com", "secret-token")
        response = io.BytesIO(b'{"id":"accepted"}')
        with patch("urllib.request.build_opener") as build:
            build.return_value.open.return_value = response
            self.assertEqual(api.request("POST", "/repos/fixture/repository/issues", {"title": "fixture"}), {"id": "accepted"})
            handler = build.call_args.args[0]
            self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://other.test"))
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://api.github.com/repos/fixture/repository/issues")
            self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertNotIn("secret-token", repr(api))

    def test_http_and_connection_errors_sanitized_with_ambiguity(self):
        for error, ambiguous in [
            (urllib.error.HTTPError("url", 401, "private-one@example.test", {}, None), False),
            (urllib.error.HTTPError("url", 503, "secret-token", {}, None), True),
            (urllib.error.HTTPError("url", 408, "secret-token", {}, None), True),
            (urllib.error.HTTPError("url", 409, "secret-token", {}, None), True),
            (TimeoutError("secret-token"), True),
        ]:
            with self.subTest(error=type(error).__name__):
                with patch("urllib.request.build_opener") as build:
                    build.return_value.open.side_effect = error
                    with self.assertRaises(ApiError) as caught:
                        JsonAPI("https://api.github.com", "secret-token").request("POST", "/repos/fixture/repository/issues")
                    self.assertEqual(caught.exception.ambiguous, ambiguous)
                    self.assertNotIn("secret-token", repr(caught.exception))
                    self.assertNotIn("private-one", repr(caught.exception))

    def test_programming_errors_are_not_wrapped_as_network_failures(self):
        with patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = RuntimeError("programming defect")
            with self.assertRaisesRegex(RuntimeError, "programming defect"):
                JsonAPI("https://api.github.com", "secret-token").request("POST", "/repos/fixture/repository/issues")


if __name__ == "__main__":
    unittest.main()

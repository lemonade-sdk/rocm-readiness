from datetime import datetime, timezone
import unittest

from scripts.collect import last_check
from scripts.findings import collection_findings, finding_errors
from scripts.validation import PipelineValidationError

SOURCES = [
    {"id": "llamacpp-stable-qualification", "engine": "llamacpp", "adapter": "qualification-v1"},
    {"id": "llamacpp-nightly-qualification", "engine": "llamacpp", "adapter": "qualification-v1"},
    {"id": "sdcpp-stable-qualification", "engine": "sdcpp", "adapter": "qualification-v1"},
    {
        "id": "lemonade-performance",
        "engine": "llamacpp",
        "adapter": "lemonade-leaderboard-v1",
        "repository": "lemonade-sdk/lemonade",
        "url": "https://raw.githubusercontent.com/lemonade-sdk/lemonade/" + "a" * 40 + "/leaderboard.json",
    },
]
BENCHMARK = {
    "source_id": "lemonade-performance",
    "record": "",
    "field": "package_evidence",
    "reason": (
        "run=44854194006 engine=b12576: benchmark job evidence access failed "
        "(exit 1, HTTP 404); authenticated GitHub log access may be required"
    ),
}


def attempt(when, status, errors=()):
    return {"attempted_at": when, "status": status, "errors": list(errors)}


class FindingsTest(unittest.TestCase):
    def test_benchmark_failure_explains_only_its_engine_and_records_recovery(self):
        sync = {
            **attempt("2026-11-25T11:04:00+00:00", "success"),
            "last_successful_at": "2026-11-25T11:04:00+00:00",
            "attempts": [
                attempt("2026-11-24T11:04:00+00:00", "failed", [BENCHMARK]),
                attempt("2026-11-24T17:38:00+00:00", "failed", [BENCHMARK]),
                attempt("2026-11-24T23:52:00+00:00", "success"),
            ],
        }
        findings = collection_findings(sync, SOURCES)
        self.assertEqual(finding_errors(findings), [])
        self.assertEqual(len(findings), 1)
        [finding] = findings
        self.assertEqual(
            finding["scopes"],
            [
                {"date": "2026-11-24", "source_id": "llamacpp-nightly-qualification"},
                {"date": "2026-11-24", "source_id": "llamacpp-stable-qualification"},
            ],
        )
        self.assertTrue(finding["finding"].startswith("Collection attempt failed:"))
        self.assertIn("(HTTP 404)", finding["finding"])
        self.assertEqual(finding["status"], "A later collection attempt on this date succeeded.")
        self.assertEqual(
            [link["url"] for link in finding["evidence"]],
            [
                "https://github.com/lemonade-sdk/lemonade/blob/" + "a" * 40 + "/leaderboard.json",
                "https://github.com/lemonade-sdk/lemonade/actions/runs/44854194006",
            ],
        )

    def test_current_unattributed_failure_explains_every_cell_on_its_date(self):
        sync = {
            **attempt("2026-11-24T11:04:00Z", "failed"),
            "last_successful_at": None,
        }
        [finding] = collection_findings(sync, SOURCES)
        self.assertEqual(finding["scopes"], [{"date": "2026-11-24"}])
        self.assertEqual(
            finding["finding"],
            "No new dashboard data: the dashboard update could not be published.",
        )
        self.assertNotIn("status", finding)

    def test_failure_after_recovery_is_not_called_recovered_and_uses_utc_date(self):
        sync = {
            **attempt("2026-11-02T20:30:00-03:00", "failed", [BENCHMARK]),
            "last_successful_at": None,
            "attempts": [
                attempt("2026-11-02T22:00:00Z", "failed", [BENCHMARK]),
                attempt("2026-11-02T22:30:00Z", "success"),
            ],
        }
        findings = collection_findings(sync, SOURCES)
        self.assertEqual(len(findings), 1)
        self.assertEqual({scope["date"] for scope in findings[0]["scopes"]}, {"2026-11-02"})
        self.assertNotIn("status", findings[0])
        self.assertTrue(findings[0]["finding"].startswith("No new dashboard data:"))

    def test_unrecognized_or_malformed_reasons_never_produce_links(self):
        for error, text in (
            ({"source_id": "unrecognized", "record": "", "field": "feed",
              "reason": "run=123 https://malicious.invalid/ unexpected"},
             "No new dashboard data: unrecognized could not be refreshed."),
            ({**BENCHMARK, "reason": BENCHMARK["reason"].replace("44854194006", "44854194006evil")}, None),
            ({"source_id": "x", "record": "", "field": "feed", "reason": "Source timed out"},
             "No new dashboard data: Source timed out."),
        ):
            sync = {**attempt("2026-11-02T11:00:00Z", "failed", [error]), "last_successful_at": None}
            with self.subTest(error=error):
                findings = collection_findings(sync, SOURCES)
                self.assertFalse(any(link["label"] == "Benchmark run" for item in findings for link in item["evidence"]))
                if text:
                    self.assertEqual([(item["finding"], item["scopes"], item["evidence"]) for item in findings],
                                     [(text, [{"date": "2026-11-02"}], [])])

    def test_unchanged_check_explains_only_its_date(self):
        run = "https://github.com/lemonade-sdk/stable-diffusion.cpp/actions/runs/1"
        sources = [
            {**SOURCES[2], "last_check": {
                "status": "unchanged", "checked_at": "2026-11-25T12:43:40Z",
                "upstream_sha": "3b12781fac1a22eda27ad0f08d0884ef816f24d7", "run_url": run,
            }},
            {**SOURCES[0], "last_check": {"status": "built", "checked_at": "2026-11-25T12:00:00Z"}},
        ]
        sync = {**attempt("2026-11-25T13:00:00Z", "success"), "last_successful_at": "2026-11-25T13:00:00Z"}
        [finding] = collection_findings(sync, sources)
        self.assertEqual(finding["kind"], "upstream_unchanged")
        self.assertEqual(finding["scopes"], [{"date": "2026-11-25", "source_id": "sdcpp-stable-qualification"}])
        self.assertIn("3b12781", finding["finding"])
        self.assertEqual(finding["evidence"], [{"label": "Check run", "url": run}])


class LastCheckTest(unittest.TestCase):
    source = {"id": "sdcpp-stable-qualification", "repository": "lemonade-sdk/stable-diffusion.cpp"}
    clock = datetime(2026, 11, 26, tzinfo=timezone.utc)

    def test_keeps_documented_fields(self):
        check = {
            "status": "unchanged", "tag": "master-1122-5519d71",
            "upstream_sha": "3b12781fac1a22eda27ad0f08d0884ef816f24d7",
            "run_id": "45391097191", "run_attempt": 1, "event": "schedule",
            "run_url": "https://github.com/lemonade-sdk/stable-diffusion.cpp/actions/runs/45391097191",
            "checked_at": "2026-11-25T12:43:40Z",
        }
        self.assertEqual(
            last_check(self.source, {"last_check": check}, self.clock),
            {key: check[key] for key in ("status", "checked_at", "run_url", "upstream_sha", "tag")},
        )
        self.assertIsNone(last_check(self.source, {}, self.clock))

    def test_rejects_unknown_status_future_time_and_foreign_run(self):
        for check in (
            {"status": "skipped", "checked_at": "2026-11-25T12:43:40Z"},
            {"status": "built", "checked_at": "2026-11-27T00:00:00Z"},
            {"status": "built", "checked_at": "2026-11-25T12:43:40Z",
             "run_url": "https://github.com/other/repo/actions/runs/1"},
        ):
            with self.subTest(check=check), self.assertRaises(PipelineValidationError):
                last_check(self.source, {"last_check": check}, self.clock)


if __name__ == "__main__":
    unittest.main()

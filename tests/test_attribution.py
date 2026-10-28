import copy
import hashlib
import json
import unittest

from scripts.attribution import attribute_stable, resolve_package
from scripts.validation import PipelineValidationError

PACKAGE = "https://github.com/lemonade-sdk/llama.cpp/releases/download/b123/llama-b123-bin-ubuntu-rocm-10.1-x64.tar.gz"


def measurement(**changes):
    row = {
        "source_id": "performance",
        "source_pointer": "/history/model/scenario/stable/0",
        "engine": "llamacpp",
        "channel": "stable",
        "backend": "rocm",
        "fork_id": "llamacpp-rocm-stable",
        "engine_repository": "lemonade-sdk/llama.cpp",
        "engine_version": "b123",
        "run_id": "42",
        "run_url": "https://github.com/lemonade-sdk/lemonade/actions/runs/42",
        "measured_at": "2026-10-27T10:05:00Z",
        "rocm_version": None,
        "qualification_build_id": None,
    }
    row.update(changes)
    return row


def evidence(**changes):
    row = {
        "repository": "lemonade-sdk/lemonade",
        "run_id": "42",
        "job_id": "99",
        "fork_id": "llamacpp-rocm-stable",
        "engine_repository": "lemonade-sdk/llama.cpp",
        "engine_version": "b123",
        "package_url": PACKAGE,
        "started_at": "2026-10-27T10:00:00Z",
        "completed_at": "2026-10-27T11:00:00Z",
        "evidence_url": "https://github.com/lemonade-sdk/lemonade/actions/runs/42/job/99",
        "log_sha256": "a" * 64,
    }
    row.update(changes)
    return row


class AttributionTests(unittest.TestCase):
    def test_reuses_only_the_same_previously_assigned_observation(self):
        original = measurement(
            model="m",
            scenario="s",
            quant="q",
            system_id="gpu",
            context_size=1024,
            input_tokens=32,
            source_url="https://raw.githubusercontent.com/a/b/"
            + "a" * 40
            + "/data.json",
        )
        attribute_stable({"measurements": [original]}, [evidence()])
        current = measurement(
            model="m",
            scenario="s",
            quant="q",
            system_id="gpu",
            context_size=1024,
            input_tokens=32,
            source_url="https://raw.githubusercontent.com/a/b/"
            + "b" * 40
            + "/data.json",
            metrics={"tps": 17},
        )

        def unavailable(row):
            raise OSError("logs unavailable")

        attribute_stable(
            {"measurements": [current]},
            [],
            unavailable,
            previous_measurements=[original],
        )
        self.assertEqual(current["package_url"], PACKAGE)
        self.assertEqual(current["attribution"]["log_sha256"], "a" * 64)
        self.assertEqual(current["metrics"], {"tps": 17})
        with self.assertRaises(PipelineValidationError):
            attribute_stable(
                {
                    "measurements": [
                        dict(current, package_url=PACKAGE.replace("10.1", "10.0"))
                    ]
                },
                [evidence()],
                previous_measurements=[original],
            )
        with self.assertRaises(PipelineValidationError):
            attribute_stable(
                {
                    "measurements": [
                        measurement(
                            model="m",
                            scenario="s",
                            quant="q",
                            system_id="gpu",
                            context_size=1024,
                            input_tokens=32,
                            source_url=original["source_url"],
                        )
                    ]
                },
                [evidence(package_url=PACKAGE.replace("10.1", "10.0"))],
                previous_measurements=[original],
            )
        for field, value in (
            ("engine_version", "b124"),
            ("run_id", "43"),
            ("engine_repository", "other/repo"),
            ("system_id", "other"),
            ("context_size", 2048),
            ("model", "unknown"),
            (
                "source_url",
                "https://raw.githubusercontent.com/c/d/" + "b" * 40 + "/data.json",
            ),
            ("package_url", PACKAGE.replace("10.1", "10.0")),
        ):
            with self.subTest(field=field), self.assertRaises(PipelineValidationError):
                changed = dict(current, **{field: value})
                attribute_stable(
                    {"measurements": [changed]},
                    [],
                    unavailable,
                    previous_measurements=[original],
                )

    def test_exact_package_assigns_rocm_and_retains_evidence(self):
        row = measurement()
        output = {"measurements": [row]}
        attribute_stable(output, [evidence()])
        self.assertEqual(row["rocm_version"], "10.1")
        self.assertEqual(row["package_url"], PACKAGE)
        self.assertEqual(row["package_os"], "linux")
        self.assertEqual(row["attribution"]["log_sha256"], "a" * 64)
        self.assertEqual(output["package_evidence"], [evidence()])

    def test_unknown_and_outside_job_window_fail_with_record_context(self):
        for records in ([], [evidence(completed_at="2026-10-27T10:01:00Z")]):
            row = measurement()
            with self.assertRaises(PipelineValidationError) as error:
                attribute_stable({"measurements": [row]}, records)
            self.assertEqual(error.exception.diagnostic["source_id"], "performance")
            self.assertEqual(
                error.exception.diagnostic["record"], row["source_pointer"]
            )
            self.assertEqual(error.exception.diagnostic["field"], "package_evidence")

    def test_rejects_conflicting_or_malformed_seed_evidence(self):
        for records in (
            [evidence(), evidence(package_url=PACKAGE.replace("10.1", "10.0"))],
            [evidence(package_url=PACKAGE.replace("/b123/", "/b999/"))],
            [evidence(evidence_url="https://other.example/log")],
        ):
            with self.subTest(records=records), self.assertRaises(ValueError):
                attribute_stable({"measurements": [measurement()]}, records)

    def test_nightly_is_deferred_and_resolver_failure_is_explicit(self):
        nightly = measurement(channel="nightly")
        stable = measurement()

        def unavailable(row):
            raise OSError("logs unavailable")

        with self.assertRaisesRegex(
            PipelineValidationError, "logs unavailable"
        ) as error:
            attribute_stable({"measurements": [nightly, stable]}, [], unavailable)
        self.assertIsNone(nightly["rocm_version"])
        self.assertEqual(error.exception.diagnostic["field"], "package_evidence")
        self.assertIsInstance(error.exception.__cause__, OSError)

    def test_resolver_selects_job_by_measurement_time_and_actual_download(self):
        job = {
            "id": 99,
            "name": "Bench llamacpp-rocm-stable",
            "started_at": "2026-10-27T10:00:00Z",
            "completed_at": "2026-10-27T11:00:00Z",
        }
        later = {
            **job,
            "id": 100,
            "started_at": "2026-10-28T10:00:00Z",
            "completed_at": "2026-10-28T11:00:00Z",
        }
        log = "  Downloading " + PACKAGE + "\n  [cache] b123 already installed\n"

        def run(args):
            return json.dumps([{"jobs": [job, later]}]) if args[0] == "api" else log

        result = resolve_package(measurement(), run)
        self.assertEqual(result["job_id"], "99")
        self.assertEqual(result["package_url"], PACKAGE)
        self.assertEqual(result["log_sha256"], hashlib.sha256(log.encode()).hexdigest())
        with self.assertRaises(ValueError):
            resolve_package(
                measurement(),
                lambda args: (
                    json.dumps([{"jobs": [job]}])
                    if args[0] == "api"
                    else "Would download: " + PACKAGE
                ),
            )

    def test_resolver_does_not_reuse_a_run_across_job_attempt_windows(self):
        first = measurement()
        second = measurement(measured_at="2026-10-28T10:05:00Z")
        calls = []

        def resolve(row):
            calls.append(row["measured_at"])
            if row is first:
                return evidence()
            return evidence(
                job_id="100",
                started_at="2026-10-28T10:00:00Z",
                completed_at="2026-10-28T11:00:00Z",
                evidence_url="https://github.com/lemonade-sdk/lemonade/actions/runs/42/job/100",
                package_url=PACKAGE.replace("10.1", "10.0"),
            )

        attribute_stable({"measurements": [first, second]}, [], resolve)
        self.assertEqual(first["rocm_version"], "10.1")
        self.assertEqual(second["rocm_version"], "10.0")
        self.assertEqual(len(calls), 2)

    def test_consistent_all_attempt_evidence_handles_historical_clock_skew(self):
        job = {
            "id": 99,
            "name": "Bench llamacpp-rocm-stable",
            "started_at": "2026-10-27T10:00:00Z",
            "completed_at": "2026-10-27T11:00:00Z",
        }
        row = measurement(measured_at="2026-10-27T03:05:00Z")

        def run(args):
            return (
                json.dumps([{"jobs": [job]}])
                if args[0] == "api"
                else " Downloading " + PACKAGE
            )

        record = resolve_package(row, run)
        self.assertEqual(record["scope"], "all_available_attempts")
        output = {"measurements": [row]}
        attribute_stable(output, [record])
        self.assertEqual(row["rocm_version"], "10.1")

    def test_attempts_with_different_packages_remain_ambiguous(self):
        jobs = [
            {
                "id": 99,
                "name": "Bench llamacpp-rocm-stable",
                "started_at": "2026-10-27T10:00:00Z",
                "completed_at": "2026-10-27T11:00:00Z",
            },
            {
                "id": 100,
                "name": "Bench llamacpp-rocm-stable",
                "started_at": "2026-10-28T10:00:00Z",
                "completed_at": "2026-10-28T11:00:00Z",
            },
        ]

        def run(args):
            if args[0] == "api":
                return json.dumps([{"jobs": jobs}])
            return " Downloading " + (
                PACKAGE if "99" in args else PACKAGE.replace("10.1", "10.0")
            )

        with self.assertRaisesRegex(ValueError, "ambiguous"):
            resolve_package(measurement(), run)

    def test_backfill_evidence_does_not_cover_future_rerun_observations(self):
        job = {
            "id": 99,
            "name": "Bench llamacpp-rocm-stable",
            "started_at": "2026-10-27T10:00:00Z",
            "completed_at": "2026-10-27T11:00:00Z",
        }
        first = measurement()
        record = resolve_package(
            first,
            lambda args: (
                json.dumps([{"jobs": [job]}])
                if args[0] == "api"
                else " Downloading " + PACKAGE
            ),
        )
        future = measurement(measured_at="2026-10-29T10:05:00Z")
        with self.assertRaises(PipelineValidationError):
            attribute_stable({"measurements": [future]}, [record])
        self.assertIsNone(future["rocm_version"])

    def test_persisted_evidence_can_extend_seed_observation_coverage(self):
        job = {
            "id": 99,
            "name": "Bench llamacpp-rocm-stable",
            "started_at": "2026-10-27T10:00:00Z",
            "completed_at": "2026-10-27T11:00:00Z",
        }
        first = resolve_package(
            measurement(),
            lambda args: (
                json.dumps([{"jobs": [job]}])
                if args[0] == "api"
                else " Downloading " + PACKAGE
            ),
        )
        extended = copy.deepcopy(first)
        extended["measurement_times"].append("2026-10-27T10:07:00Z")
        row = measurement(measured_at="2026-10-27T10:07:00Z")
        output = {"measurements": [row]}
        attribute_stable(output, [first, extended])
        self.assertEqual(row["rocm_version"], "10.1")
        self.assertEqual(len(output["package_evidence"]), 1)

    def test_seed_scope_does_not_accept_unlisted_timestamp_inside_job_window(self):
        job = {
            "id": 99,
            "name": "Bench llamacpp-rocm-stable",
            "started_at": "2026-10-27T10:00:00Z",
            "completed_at": "2026-10-27T11:00:00Z",
        }
        record = resolve_package(
            measurement(),
            lambda args: (
                json.dumps([{"jobs": [job]}])
                if args[0] == "api"
                else " Downloading " + PACKAGE
            ),
        )
        row = measurement(measured_at="2026-10-27T10:09:00Z")
        with self.assertRaises(PipelineValidationError):
            attribute_stable({"measurements": [row]}, [record])
        self.assertIsNone(row["rocm_version"])

    def test_grouped_benchmark_jobs_must_agree_on_the_stable_package(self):
        jobs = [
            {
                "id": i,
                "name": f"Bench group-{i}",
                "started_at": "2026-10-27T10:00:00Z",
                "completed_at": "2026-10-27T11:00:00Z",
            }
            for i in (1, 2)
        ]
        result = resolve_package(
            measurement(),
            lambda args: (
                json.dumps([{"jobs": jobs}])
                if args[0] == "api"
                else " Downloading " + PACKAGE
            ),
        )
        self.assertEqual(len(result["job_evidence"]), 2)
        self.assertEqual(result["package_url"], PACKAGE)

    def test_new_representative_job_merges_compatible_run_evidence(self):
        old = measurement()
        newer = measurement(measured_at="2026-10-28T10:05:00Z")

        def job(i):
            return {
                "id": i,
                "name": "Bench llamacpp-rocm-stable",
                "started_at": "2026-10-27T10:00:00Z",
                "completed_at": "2026-10-28T11:00:00Z",
            }

        def resolver_for(jobs):
            return lambda row: resolve_package(
                row,
                lambda args: (
                    json.dumps([{"jobs": jobs}])
                    if args[0] == "api"
                    else " Downloading " + PACKAGE
                ),
            )

        seed = resolver_for([job(99)])(old)
        output = {"measurements": [newer, old]}
        attribute_stable(output, [seed], resolver_for([job(100), job(99)]))
        self.assertTrue(
            all(row["rocm_version"] == "10.1" for row in output["measurements"])
        )
        self.assertEqual(len(output["package_evidence"]), 1)
        self.assertEqual(len(output["package_evidence"][0]["job_evidence"]), 2)

    def test_invalid_evidence_timestamp_has_structured_context(self):
        with self.assertRaises(PipelineValidationError) as error:
            attribute_stable(
                {"measurements": [measurement()]}, [evidence(started_at=None)]
            )
        self.assertEqual(error.exception.diagnostic["record"], "/packages/0")
        self.assertEqual(error.exception.diagnostic["field"], "package_evidence")

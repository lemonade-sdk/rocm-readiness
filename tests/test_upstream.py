import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

from scripts import publish
from scripts.collect import write_json
from scripts.conformance import validate_dataset
from scripts.dataset import write_dataset
from scripts.upstream import (
    _state,
    collect_upstream,
    load_previous,
    matcher,
    validate_projects,
    validate_upstream_dataset,
)
from scripts.validation import PipelineValidationError
from tests.test_dataset import build, normalized

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)


def project(**overrides):
    base = {
        "id": "demo",
        "label": "Demo",
        "repository": "example/demo",
        "default_branch": "master",
        "forks": [
            {"repository": "fork/demo", "role": "nightly builds", "channel": "nightly"}
        ],
        "ships": {"linux": "archive"},
        "jobs": [
            {
                "id": "gpu",
                "label": "gpu test",
                "category": "tests",
                "workflow": "ci.yml",
                "match": {"name": "gpu-rocm"},
                "target": "gfx1151",
                "stack": "rocm",
                "os": "linux",
                "where": "Strix Halo",
                "cadence": "per push",
            },
            {
                "id": "build",
                "label": "hip build",
                "category": "builds",
                "workflow": "build.yml",
                "match": {"prefix": "hip"},
                "target": "gfx1030",
                "stack": "rocm",
                "os": "linux",
                "where": "GitHub-hosted",
                "cadence": "per push",
            },
        ],
    }
    base.update(overrides)
    return base


def config(*projects, window=30):
    return {
        "schema_version": 1,
        "window_days": window,
        "client_rule": {"targets": ["gfx1151", "gfx1201"]},
        "projects": list(projects) or [project()],
    }


def run(run_id, created, event="push", ref="master", sha=None, status="completed"):
    return {
        "id": run_id,
        "created_at": created,
        "event": event,
        "head_branch": ref,
        "head_sha": sha or f"{run_id:040x}",
        "status": status,
        "run_attempt": 1,
        "html_url": f"https://github.com/example/demo/actions/runs/{run_id}",
    }


def job(
    job_id,
    name,
    conclusion="success",
    steps=True,
    failed_step=None,
    status="completed",
    created="2026-10-28T10:00:00Z",
    started="2026-10-28T10:05:00Z",
):
    rows = []
    if steps:
        rows = [
            {"name": "Set up job", "conclusion": "success"},
            {
                "name": failed_step or "Test",
                "conclusion": "failure" if failed_step else "success",
            },
        ]
    return {
        "id": job_id,
        "name": name,
        "status": status,
        "conclusion": conclusion,
        "created_at": created,
        "started_at": started if steps else None,
        "runner_name": "box-1",
        "html_url": f"https://github.com/example/demo/actions/runs/1/job/{job_id}",
        "steps": rows,
    }


class FakeGitHub:
    """Serves the handful of Actions endpoints the collector reads."""

    def __init__(self):
        self.runs = {}  # workflow -> [run]
        self.jobs = {}  # run id -> [job]
        self.pulls = {}  # sha -> [pull]
        self.checks = {}  # sha -> [check run]
        self.calls = []

    def __call__(self, url):
        self.calls.append(url)
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        parts = parsed.path.split("/")
        if "workflows" in parts:
            workflow = parts[parts.index("workflows") + 1]
            start, _, end = query["created"][0].partition("..")
            rows = [
                r
                for r in self.runs.get(workflow, [])
                if start <= r["created_at"][:10] <= (end or "9999")
            ]
            if "branch" in query:
                rows = [r for r in rows if r["head_branch"] == query["branch"][0]]
            if "event" in query:
                rows = [r for r in rows if r["event"] == query["event"][0]]
            rows.sort(key=lambda r: r["created_at"], reverse=True)
            page = int(query.get("page", ["1"])[0])
            return {
                "total_count": len(rows),
                "workflow_runs": rows[(page - 1) * 100 : page * 100],
            }
        if parts[-1] == "jobs":
            rows = self.jobs.get(int(parts[-2]), [])
            return {"total_count": len(rows), "jobs": rows}
        if parts[-1] == "pulls":
            return self.pulls.get(parts[-2], [])
        if parts[-1] == "check-runs":
            rows = self.checks.get(parts[-2], [])
            page = int(query.get("page", ["1"])[0])
            return {
                "total_count": len(rows),
                "check_runs": rows[(page - 1) * 100 : page * 100],
            }
        raise OSError(f"unexpected url {url}")


def merged(number, head):
    return [
        {
            "number": number,
            "html_url": f"https://github.com/example/demo/pull/{number}",
            "head": {"sha": head},
            "user": {"login": "dev"},
            "merged_at": "2026-10-28T09:00:00Z",
            "base": {"ref": "master"},
        }
    ]


def check(name, conclusion):
    return {
        "name": name,
        "conclusion": conclusion,
        "started_at": "2026-10-28T08:00:00Z",
        "html_url": f"https://github.com/example/demo/runs/{name}",
    }


def collect(github, destination, cfg=None, previous=None, budget=10_000):
    return collect_upstream(
        cfg or config(),
        Path(destination),
        fetch=github,
        now=NOW,
        write_json=write_json,
        previous_data=previous,
        budget_calls=budget,
        workers=2,
    )


def overview(root):
    return json.loads((Path(root) / "upstream/overview.json").read_text())


class ConfigTests(unittest.TestCase):
    def test_repository_projects_file_is_valid(self):
        validate_projects(json.loads((ROOT / "projects.json").read_text()))

    def test_rejects_unknown_category_duplicate_ids_and_bad_matchers(self):
        for change, field in (
            (
                lambda c: c["projects"][0]["jobs"][0].update(category="smoke"),
                "/category",
            ),
            (lambda c: c["projects"].append(copy.deepcopy(c["projects"][0])), "/id"),
            (
                lambda c: c["projects"][0]["jobs"][0].update(match={"regex": "("}),
                "/match",
            ),
            (
                lambda c: c["projects"][0]["jobs"][0].update(
                    match={"name": "a", "prefix": "b"}
                ),
                "/match",
            ),
            (
                lambda c: c["projects"][0]["jobs"][0].update(workflow="../x.yml"),
                "/workflow",
            ),
            (lambda c: c["projects"][0]["forks"][0].update(channel="beta"), "/channel"),
            (lambda c: c.update(window_days=0), "/window_days"),
        ):
            cfg = config()
            change(cfg)
            with self.subTest(field=field), self.assertRaises(
                PipelineValidationError
            ) as raised:
                validate_projects(cfg)
            self.assertIn(field, raised.exception.diagnostic["field"])

    def test_matchers(self):
        self.assertTrue(matcher({"name": "rocm"})("rocm"))
        self.assertFalse(matcher({"name": "rocm"})("rocm-x"))
        self.assertTrue(
            matcher({"prefix": "ubuntu-24-rocm"})("ubuntu-24-rocm (10.0.0, gfx908)")
        )
        self.assertTrue(
            matcher({"regex": r"^linux-\w+-rx7900 / test "})(
                "linux-jammy-rx7900 / test (default, 1)"
            )
        )


class StateTests(unittest.TestCase):
    def test_a_job_is_judged_by_its_own_steps_and_conclusion(self):
        self.assertEqual(_state(job(1, "x")), "passed")
        self.assertEqual(_state(job(1, "x", "failure", failed_step="Test")), "failed")
        self.assertEqual(_state(job(1, "x", "cancelled")), "other")
        # No steps means no machine ever took it.
        self.assertEqual(_state(job(1, "x", "skipped", steps=False)), "skipped")
        self.assertEqual(_state(job(1, "x", "cancelled", steps=False)), "stalled")
        self.assertEqual(
            _state(job(1, "x", None, steps=False, status="queued")), "stalled"
        )
        self.assertEqual(_state(job(1, "x", None, status="in_progress")), "running")


def fake_github():
    gh = FakeGitHub()
    gh.runs["ci.yml"] = [
        run(1, "2026-10-28T10:00:00Z", sha="a" * 40),
        run(2, "2026-10-27T10:00:00Z", sha="b" * 40),
        run(3, "2026-10-26T10:00:00Z", event="pull_request", ref="feature"),
        run(4, "2026-10-25T10:00:00Z", ref="ciflow/ci/123"),
        run(5, "2026-09-01T10:00:00Z", sha="c" * 40),  # outside the window
    ]
    gh.runs["build.yml"] = [run(6, "2026-10-28T11:00:00Z", sha="a" * 40)]
    gh.jobs[1] = [job(11, "gpu-rocm"), job(12, "cpu")]
    gh.jobs[2] = [job(21, "gpu-rocm", "failure", failed_step="Test")]
    gh.jobs[3] = [job(31, "gpu-rocm")]
    gh.jobs[4] = [job(41, "gpu-rocm")]
    gh.jobs[6] = [job(61, "hip (x64)")]
    gh.pulls["a" * 40] = merged(100, "d" * 40)
    gh.pulls["b" * 40] = merged(101, "e" * 40)
    gh.checks["d" * 40] = [check("gpu-rocm", "failure")]  # merged red
    gh.checks["e" * 40] = [check("gpu-rocm", "success")]
    return gh


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.gh = fake_github()

    def test_only_default_branch_runs_are_recorded(self):
        entry = collect(self.gh, self.out)
        self.assertEqual(entry["status"], "fresh")
        data = json.loads((self.out / "upstream/demo/ci/2026-10.json").read_text())
        self.assertEqual(sorted(r["run_id"] for r in data["runs"]), ["1", "2", "6"])
        self.assertFalse(
            any("runs/3/" in url or "runs/4/" in url for url in self.gh.calls)
        )

    def test_merge_verdict_comes_from_the_merged_commit(self):
        collect(self.gh, self.out)
        gpu = next(
            j for j in overview(self.out)["projects"][0]["jobs"] if j["id"] == "gpu"
        )
        self.assertEqual(gpu["gate"]["merged"], 2)
        self.assertEqual(gpu["gate"]["failed"], 1)
        self.assertEqual([g["number"] for g in gpu["gate"]["red"]], [100])
        build_job = next(
            j for j in overview(self.out)["projects"][0]["jobs"] if j["id"] == "build"
        )
        # No hip check on the PR commit: the job never ran on the pull request.
        self.assertEqual(build_job["gate"]["not_triggered"], 1)

    def test_kpis_badge_and_findings(self):
        collect(self.gh, self.out)
        card = overview(self.out)["projects"][0]
        self.assertEqual(card["kpis"]["decided"], 3)
        self.assertEqual(card["kpis"]["passed"], 2)
        self.assertEqual(card["kpis"]["merged_red"], 1)
        self.assertEqual(card["badge"]["state"], "up")
        self.assertIn("gfx1151", card["badge"]["reason"])
        self.assertEqual(card["findings"][0]["kind"], "merged_red")
        self.assertEqual(card["platforms"]["linux"]["shipped"], "archive")
        self.assertFalse(card["platforms"]["windows"]["tested"])

    def test_badge_is_partial_for_other_client_hardware_and_down_without_tests(self):
        cfg = config(project())
        cfg["projects"][0]["jobs"][0]["target"] = "Ryzen AI NPU"
        collect(self.gh, self.out, cfg)
        self.assertEqual(overview(self.out)["projects"][0]["badge"]["state"], "partial")
        cfg["projects"][0]["jobs"] = cfg["projects"][0]["jobs"][1:]
        cfg["projects"][0]["note"] = "No client GPU is tested upstream."
        collect(self.gh, self.out, cfg)
        card = overview(self.out)["projects"][0]
        self.assertEqual(
            card["badge"],
            {"state": "down", "reason": "No client GPU is tested upstream."},
        )

    def test_previous_records_are_reused_without_new_calls(self):
        collect(self.gh, self.out)
        index = {"upstream": {"overview": "upstream/overview.json"}}
        (self.out / "index.json").write_text(json.dumps(index))
        runs, scanned, coverage = load_previous(self.out)
        self.assertEqual(len(runs["demo"]), 3)
        self.assertTrue(coverage["demo"]["complete"])
        self.gh.calls.clear()
        with tempfile.TemporaryDirectory() as second:
            collect(self.gh, second, previous=self.out)
            self.assertFalse([u for u in self.gh.calls if "/jobs" in u])
            self.assertEqual(
                overview(second)["projects"][0]["kpis"],
                overview(self.out)["projects"][0]["kpis"],
            )

    def test_budget_keeps_newest_runs_and_reports_partial(self):
        entry = collect(self.gh, self.out, budget=3)
        self.assertEqual(entry["status"], "partial")
        card = overview(self.out)["projects"][0]
        self.assertFalse(card["coverage"]["complete"])

    def test_a_failed_read_costs_one_run_not_the_project(self):
        broken = self.gh

        def flaky(url):
            if "/runs/2/jobs" in url:
                raise OSError("502 Bad Gateway")
            return broken(url)

        collect_upstream(
            config(), self.out, fetch=flaky, now=NOW, write_json=write_json, workers=2
        )
        card = overview(self.out)["projects"][0]
        self.assertFalse(card["coverage"]["complete"])
        self.assertEqual(card["kpis"]["decided"], 2)  # runs 1 and 6 survive

    def test_stall_after_last_run_is_reported(self):
        self.gh.runs["ci.yml"].insert(0, run(7, "2026-10-29T08:00:00Z", sha="f" * 40))
        self.gh.jobs[7] = [job(71, "gpu-rocm", "cancelled", steps=False)]
        collect(self.gh, self.out)
        card = overview(self.out)["projects"][0]
        gpu = next(j for j in card["jobs"] if j["id"] == "gpu")
        self.assertEqual(gpu["quiet_days"], ["2026-10-29"])
        self.assertEqual(card["kpis"]["not_running"], 1)
        self.assertTrue(any(f["kind"] == "not_running" for f in card["findings"]))

    def test_a_removed_job_does_not_break_the_next_publication(self):
        collect(self.gh, self.out)
        (self.out / "index.json").write_text(
            json.dumps({"upstream": {"overview": "upstream/overview.json"}})
        )
        cfg = config()
        cfg["projects"][0]["jobs"] = cfg["projects"][0]["jobs"][:1]
        with tempfile.TemporaryDirectory() as second:
            entry = collect(self.gh, second, cfg, previous=self.out)
            self.assertEqual(
                validate_upstream_dataset(second, entry) >= {"upstream/overview.json"},
                True,
            )
            card = overview(second)["projects"][0]
            self.assertEqual([j["id"] for j in card["jobs"]], ["gpu"])

    def test_a_lost_merge_verdict_is_read_again(self):
        broken = self.gh

        def no_pulls(url):
            if url.endswith("/pulls"):
                raise OSError("502 Bad Gateway")
            return broken(url)

        collect_upstream(
            config(),
            self.out,
            fetch=no_pulls,
            now=NOW,
            write_json=write_json,
            workers=2,
        )
        self.assertFalse(overview(self.out)["projects"][0]["coverage"]["complete"])
        (self.out / "index.json").write_text(
            json.dumps({"upstream": {"overview": "upstream/overview.json"}})
        )
        with tempfile.TemporaryDirectory() as second:
            collect(self.gh, second, previous=self.out)
            gpu = overview(second)["projects"][0]["jobs"][0]
            self.assertEqual(gpu["gate"]["merged"], 2)
            self.assertTrue(overview(second)["projects"][0]["coverage"]["complete"])

    def test_a_rerun_replaces_its_earlier_attempt(self):
        collect(self.gh, self.out)
        (self.out / "index.json").write_text(
            json.dumps({"upstream": {"overview": "upstream/overview.json"}})
        )
        rerun = dict(self.gh.runs["ci.yml"][1], run_attempt=2)
        self.gh.runs["ci.yml"][1] = rerun
        self.gh.jobs[2] = [job(22, "gpu-rocm")]
        with tempfile.TemporaryDirectory() as second:
            collect(self.gh, second, previous=self.out)
            data = json.loads(
                (Path(second) / "upstream/demo/ci/2026-10.json").read_text()
            )
            run2 = [r for r in data["runs"] if r["run_id"] == "2"]
            self.assertEqual(
                [(r["job_id"], r["state"], r["attempt"]) for r in run2],
                [("22", "passed", 2)],
            )

    def test_one_failing_shard_makes_the_verdict_failed(self):
        cfg = config()
        cfg["projects"][0]["jobs"][0]["match"] = {"prefix": "gpu-rocm"}
        self.gh.checks["e" * 40] = [
            dict(check("gpu-rocm (1)", "failure"), started_at="2026-10-28T08:00:00Z"),
            dict(check("gpu-rocm (2)", "success"), started_at="2026-10-28T09:00:00Z"),
        ]
        collect(self.gh, self.out, cfg)
        gpu = overview(self.out)["projects"][0]["jobs"][0]
        self.assertEqual(gpu["gate"]["failed"], 2)

    def test_a_cut_off_check_list_is_not_read_as_never_ran(self):
        self.gh.checks["e" * 40] = [check(f"other-{i}", "success") for i in range(1001)]
        collect(self.gh, self.out)
        build_job = overview(self.out)["projects"][0]["jobs"][1]
        gpu = overview(self.out)["projects"][0]["jobs"][0]
        self.assertEqual(gpu["gate"]["no_result"], 1)
        self.assertEqual(build_job["gate"]["not_triggered"], 1)

    def test_an_over_long_run_list_is_split_not_truncated(self):
        from scripts import upstream

        self.gh.runs["ci.yml"] = [
            run(1000 + i, f"2026-10-{1 + i % 28:02d}T10:00:00Z", sha=f"{i:040x}")
            for i in range(150)
        ]
        old = upstream.MAX_RUN_PAGES
        upstream.MAX_RUN_PAGES = 1
        try:
            collect(self.gh, self.out)
        finally:
            upstream.MAX_RUN_PAGES = old
        listed = {
            u.split("created=")[1]
            for u in self.gh.calls
            if "/workflows/ci.yml/" in u and "page=1" in u
        }
        self.assertGreater(len(listed), 1)
        self.assertTrue(overview(self.out)["projects"][0]["coverage"]["complete"])

    def test_every_read_is_charged_to_the_budget(self):
        entry = collect(self.gh, self.out, budget=10_000)
        self.assertEqual(entry["api_calls"], len(self.gh.calls))


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        index = write_dataset(
            normalized([build("latest", generated_at="2026-10-01T00:00:00Z")]),
            self.root,
        )
        index["upstream"] = collect(fake_github(), self.root)
        (self.root / "index.json").write_text(json.dumps(index))

    def test_conformance_and_publication_include_upstream_files(self):
        paths = validate_dataset(self.root)
        self.assertIn("upstream/overview.json", paths)
        self.assertIn("upstream/demo/ci/2026-10.json", paths)
        self.assertIn("upstream/demo/ci/2026-10.json", publish.manifest(self.root))

    def mutate(self, relative, change):
        target = self.root / relative
        data = json.loads(target.read_text())
        change(data)
        target.write_text(json.dumps(data))

    def test_restore_drops_an_upstream_view_that_no_longer_validates(self):
        overview_path = self.root / "upstream/overview.json"
        data = json.loads(overview_path.read_text())
        data["schema_version"] = 99
        overview_path.write_text(json.dumps(data))
        publish.drop_invalid_upstream(self.root)
        self.assertNotIn("upstream", json.loads((self.root / "index.json").read_text()))
        self.assertFalse((self.root / "upstream").exists())
        self.assertNotIn("upstream/overview.json", publish.manifest(self.root))

    def test_tampered_upstream_files_are_rejected(self):
        for relative, change, field in (
            ("upstream/demo/ci/2026-10.json", lambda d: d["runs"].pop(), "/runs"),
            (
                "upstream/demo/ci/2026-10.json",
                lambda d: d["runs"][0].update(state="green"),
                "/state",
            ),
            (
                "upstream/overview.json",
                lambda d: d["projects"][0]["kpis"].update(passed=99),
                "/kpis",
            ),
            (
                "upstream/overview.json",
                lambda d: d["projects"][0]["files"][0].update(
                    path="upstream/../index.json"
                ),
                "/files",
            ),
            (
                "index.json",
                lambda d: d["upstream"].update(overview="other.json"),
                "/upstream/overview",
            ),
        ):
            with self.subTest(field=field):
                backup = {p: p.read_text() for p in self.root.rglob("*.json")}
                self.mutate(relative, change)
                with self.assertRaises(PipelineValidationError) as raised:
                    validate_upstream_dataset(
                        self.root,
                        json.loads((self.root / "index.json").read_text())["upstream"],
                    )
                self.assertIn(field, raised.exception.diagnostic["field"])
                for path, text in backup.items():
                    path.write_text(text)


if __name__ == "__main__":
    unittest.main()

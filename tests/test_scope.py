import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.attribution import attribute_stable
from scripts.collect import collect, normalize_performance, validate_config
from scripts.dataset import write_dataset
from tests.test_attribution import evidence, measurement
from tests.test_collect import fixture
from tests.test_dataset import SOURCE_A, build, normalized


class ScopeTests(unittest.TestCase):
    def test_pending_nightly_source_records_confirmed_location_without_fetching(self):
        source = {
            "id": "llamacpp-nightly-qualification",
            "engine": "llamacpp",
            "adapter": "qualification-v1",
            "availability": "awaiting_data",
            "channel": "nightly",
            "repository": "lemonade-sdk/llamacpp-rocm",
            "ref": "qualification-data",
        }
        config = {
            "schema_version": 1,
            "engines": [{"id": "llamacpp"}],
            "sources": [source],
        }

        def unavailable(url):
            raise AssertionError("pending producer must not be fetched: " + url)

        with tempfile.TemporaryDirectory() as directory:
            result = collect(
                config, Path(directory), fetch=unavailable, now="2026-10-28T12:00:00Z"
            )
            pending = result["dataset"]["sources"][0]
            self.assertEqual(pending["status"], "awaiting_data")
            self.assertEqual(pending["repository"], "lemonade-sdk/llamacpp-rocm")
            self.assertEqual(pending["ref"], "qualification-data")
            self.assertEqual(result["builds"], [])
            self.assertEqual(result["collection_status"], "complete")

    def test_performance_allowlist_filters_latest_and_history_before_attribution(self):
        source = fixture("performance-source.json")
        source["include_forks"] = ["stable"]
        source["forks"]["stable"] = dict(
            source["forks"]["llamacpp-rocm-nightly"],
            channel="stable",
            repository="lemonade-sdk/llama.cpp",
        )
        data = fixture("performance.json")
        latest = next(iter(data["by_model_scenario"].values()))[0]
        stable = dict(
            latest,
            fork_id="stable",
            fork_repo="lemonade-sdk/llama.cpp",
            fork_version="b123",
        )
        next(iter(data["by_model_scenario"].values())).append(stable)
        data["history"]["Gemma-4-26B-A4B-it-GGUF"]["context-32k"]["stable"] = [
            dict(
                next(iter(data["history"].values()))["context-32k"][
                    "llamacpp-rocm-nightly"
                ][0],
                version="b123",
            )
        ]
        latest["tps_mean"] = "excluded malformed metric"
        rows = normalize_performance(source, data)
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["fork_id"] for r in rows}, {"stable"})
        self.assertEqual({r["engine_version"] for r in rows}, {"b123"})
        self.assertEqual({r["run_id"] for r in rows}, {"40459300755", "40290464171"})
        self.assertTrue(all(r["channel"] == "stable" for r in rows))
        data["by_model_scenario"]["model|context-32k"][-1]["fork_repo"] = "wrong/repo"
        with self.assertRaisesRegex(ValueError, "producer identity"):
            normalize_performance(source, data)

    def test_missing_fork_identity_fails_instead_of_being_filtered_out(self):
        source = fixture("performance-source.json")
        source["include_forks"] = ["llamacpp-rocm-nightly"]
        data = fixture("performance.json")
        del data["by_model_scenario"]["model|context-32k"][0]["fork_id"]
        with self.assertRaisesRegex(ValueError, "fork_id"):
            normalize_performance(source, data)

    def test_invalid_allowlist_cannot_silently_drop_the_feed(self):
        config = json.loads(Path("sources.json").read_text())
        source = next(
            s for s in config["sources"] if s["adapter"] == "lemonade-leaderboard-v1"
        )
        for value in (
            [],
            "stable",
            ["not-configured"],
            ["llamacpp-rocm-stable", "llamacpp-rocm-stable"],
        ):
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "fork selection"
            ):
                validate_config(
                    {**config, "sources": [{**source, "include_forks": value}]}
                )

    def test_regeneration_prunes_excluded_history_without_removing_vllm(self):
        stable = measurement(
            model="model",
            scenario="chat",
            quant="Q4",
            system_id=None,
            source_url=SOURCE_A,
        )
        attribute_stable({"measurements": [stable]}, [evidence()])
        excluded = copy.deepcopy(stable)
        excluded.update(fork_id="nightly", channel="nightly", rocm_version="10.3")
        excluded["package_url"] = excluded["package_url"].replace("10.1", "10.3")
        excluded["attribution"]["package_url"] = excluded["package_url"]
        previous_output = normalized(
            [
                build(
                    "old-nightly",
                    source_id="removed-nightly",
                    channel="nightly",
                    rocm_version="10.3",
                    source_url=SOURCE_A,
                ),
                build(
                    "vllm-nightly",
                    source_id="vllm",
                    engine="vllm",
                    channel="nightly",
                    source_url=SOURCE_A,
                ),
            ],
            [stable, excluded],
        )
        previous_output["sources"].extend(
            [
                {"id": sid, "engine": engine, "url": SOURCE_A}
                for sid, engine in [("removed-nightly", "llamacpp"), ("vllm", "vllm")]
            ]
        )
        scopes = {
            "llama-source": {
                "engine": "llamacpp",
                "repository": "example/source",
                "adapter": "qualification-v1",
                "channel": "stable",
            },
            "vllm": {
                "engine": "vllm",
                "repository": "example/source",
                "adapter": "qualification-v1",
                "channel": "from-record",
            },
            "performance": {
                "engine": "llamacpp",
                "repository": "example/source",
                "adapter": "lemonade-leaderboard-v1",
                "include_forks": ["llamacpp-rocm-stable"],
                "forks": {
                    "llamacpp-rocm-stable": {
                        "engine": "llamacpp",
                        "channel": "stable",
                        "backend": "rocm",
                        "repository": "lemonade-sdk/llama.cpp",
                    }
                },
            },
        }
        scopes["removed-nightly"] = {
            "engine": "llamacpp",
            "repository": "example/source",
            "adapter": "qualification-v1",
            "channel": "nightly",
            "availability": "awaiting_data",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_dataset(previous_output, root / "previous")
            index = write_dataset(
                normalized(),
                root / "current",
                previous_data=root / "previous",
                source_configs=scopes,
            )
            self.assertEqual(
                {v["rocm_version"] for v in index["versions"]}, {"7.14", "10.1"}
            )
            records = json.loads(
                (root / "current/rocm/10.1/performance.json").read_text()
            )["measurements"]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["fork_id"], "llamacpp-rocm-stable")
            retained = json.loads(
                (root / "current/rocm/7.14/history/2026-10.json").read_text()
            )["builds"]
            self.assertEqual(
                [(r["engine"], r["channel"]) for r in retained], [("vllm", "nightly")]
            )
            self.assertNotIn("comparison_performance", index)
            self.assertFalse((root / "current/performance").exists())
            self.assertFalse((root / "current/rocm/10.3").exists())
            self.assertFalse((root / "current/performance/unassigned.json").exists())

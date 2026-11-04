import unittest
from datetime import date
from urllib.error import HTTPError

from scripts import readiness


class PublishedSelectionTests(unittest.TestCase):
    def test_selects_latest_publication_in_each_available_track(self):
        def release(channel, version, day, tag):
            return dict(
                channel=channel,
                version=version,
                tag=tag,
                published_at=f"2026-11-{day:02}T00:00:00Z",
            )

        stable = release("stable", "10.1", 4, "stable")
        older = release("nightly", "10.2.0a20261022", 1, "older")
        newer = release("nightly", "10.2.0a20261023", 2, "newer")
        next_track = release("nightly", "10.3.0a20261104", 4, "next")
        extra = release("nightly", "10.10.0a20261104", 4, "extra")
        for available, expected in [
            ([], [stable]),
            ([next_track], [stable, next_track]),
            ([extra, newer, older, next_track], [stable, newer, next_track]),
        ]:
            with self.subTest(available=available):
                select = getattr(readiness, "select_releases", None)
                self.assertIsNotNone(select, "published selection is missing")
                self.assertEqual(select([stable, *available], 2), expected)


class ReleaseDiscoveryTests(unittest.TestCase):
    stable_repo = "lemonade-sdk/llama.cpp"
    nightly_repo = "lemonade-sdk/llamacpp-rocm"
    repositories = {"stable": stable_repo, "nightly": nightly_repo}

    @staticmethod
    def release(tag, version, day, *, report=False):
        nightly = "a" in version
        name = (
            f"llama-{tag}-ubuntu-rocm-gfx1151-x64.zip"
            if nightly
            else f"llama-{tag}-bin-ubuntu-rocm-{version}-x64.tar.gz"
        )
        names = [name]
        if report:
            names.append(f"qualification-{name.removesuffix('.zip')}.json")
        return {
            "tag_name": tag,
            "draft": False,
            "published_at": f"2026-11-{day:02}T00:00:00Z",
            "body": f"**ROCm Version**: {version}",
            "assets": [dict(name=name, state="uploaded", size=1) for name in names],
        }

    def setUp(self):
        self.stable = self.release("b12109", "10.1", 4)
        self.old = self.release("b1352", "10.2.0a20261022", 1)
        self.new = self.release("b1365", "10.3.0a20261104", 4, report=True)

    def test_incremental_discovery_retains_and_revalidates_older_track(self):
        from scripts.release_inventory import discover

        placeholders = [
            {**self.new, "tag_name": f"unrelated-{i}", "assets": []} for i in range(98)
        ]

        def fetch(url):
            if f"/repos/{self.stable_repo}/" in url:
                return self.stable if "/tags/" in url else [self.stable]
            if url.endswith("page=1"):
                return [
                    self.new,
                    *placeholders,
                    {**self.new, "tag_name": "other", "assets": []},
                ]
            if url.endswith("page=2"):
                return [self.old]
            return {"b1352": self.old, "b1365": self.new}[url.rsplit("/", 1)[-1]]

        today = date(2026, 11, 4)
        inventory, initial = discover(self.repositories, 2, fetch, today=today)
        self.assertEqual([row["tag"] for row in initial], ["b12109", "b1352", "b1365"])

        def incremental(url):
            self.assertFalse(
                url.endswith("page=2"), "known first page should stop the scan"
            )
            return fetch(url)

        _, selected = discover(
            self.repositories, 2, incremental, inventory, today=today
        )
        self.assertEqual(selected, initial)

        # A full rescan sees a newly published older release beyond the marker.
        replacement = self.release("b1353", "10.2.0a20261023", 5)

        def rescan(url):
            if url.endswith("page=2"):
                return [self.old, replacement]
            if url.endswith("/tags/b1353"):
                return replacement
            return fetch(url)

        refreshed, selected = discover(
            self.repositories, 2, rescan, inventory, today=date(2026, 11, 11)
        )
        self.assertEqual(selected[1]["tag"], "b1353")
        self.assertEqual(refreshed["heads"]["nightly"]["full_scan"], "2026-11-11")

    def test_candidate_removed_and_api_failure_are_distinct(self):
        from scripts.release_inventory import discover

        def fetch(url, code):
            if f"/repos/{self.stable_repo}/" in url:
                return self.stable if "/tags/" in url else [self.stable]
            if "/tags/" in url:
                raise HTTPError(url, code, "API response", None, None)
            return [self.old]

        _, selected = discover(self.repositories, 2, lambda url: fetch(url, 404))
        self.assertEqual([row["tag"] for row in selected], ["b12109"])
        with self.assertRaises(HTTPError) as failure:
            discover(self.repositories, 2, lambda url: fetch(url, 503))
        self.assertEqual(failure.exception.code, 503)

    def test_collect_publishes_an_unqualified_track_and_attached_report(self):
        import tempfile
        from pathlib import Path

        from scripts.collect import collect
        from scripts.publish import manifest
        from tests.test_current_tracks import CurrentTracksTests

        config = CurrentTracksTests().config()
        config["readiness"]["release_repositories"] = self.repositories

        def fetch(url):
            nightly = f"/{self.nightly_repo}/" in url
            if "/commits/" in url:
                return {"sha": "a" * 40}
            if url.endswith("qualification/index.json"):
                if nightly:
                    raise HTTPError(url, 404, "missing feed", None, None)
                return {
                    "schema_version": 1,
                    "builds": [],
                    "repo": self.nightly_repo if nightly else self.stable_repo,
                }
            if url.endswith(".json"):
                return {
                    "build": {
                        "release_tag": "b1365",
                        "artifact": "llama-b1365-ubuntu-rocm-gfx1151-x64.zip",
                        "rocm_version": "10.3.0a20261104",
                    },
                    "qualified": True,
                    "overall": "pass",
                }
            if "/tags/" in url:
                return {
                    row["tag_name"]: row for row in (self.stable, self.old, self.new)
                }[url.rsplit("/", 1)[-1]]
            return [self.old, self.new] if nightly else [self.stable]

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            output = collect(config, root, fetch=fetch, now="2026-11-04T18:00:00Z")
            stable, older, newer = output["dataset"]["versions"]
            self.assertEqual(output["sources"][1]["status"], "awaiting_data")
            self.assertEqual(stable["release"]["tag"], "b12109")
            self.assertEqual(older["release"]["version"], "10.2.0a20261022")
            self.assertEqual(older["build_count"], 0)
            self.assertNotIn("qualified", older["release"]["archives"][0])
            self.assertIs(newer["release"]["archives"][0]["qualified"], True)
            self.assertIn("release-inventory.json", manifest(root))

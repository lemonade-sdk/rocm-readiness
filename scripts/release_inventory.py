"""Discover published ROCm archives independently of qualification evidence."""

import json
import re
from datetime import date, datetime, timezone
from urllib.error import HTTPError
from urllib.parse import quote

if __package__:
    from .readiness import release_minor, select_releases
else:
    from readiness import release_minor, select_releases

INVENTORY = "release-inventory.json"
REPOSITORY = re.compile(r"[\w.-]+/[\w.-]+")
VERSION = r"[0-9]+\.[0-9]+(?:\.[0-9]+)?"
STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


def release_rows(repository, channel, release):
    if release["draft"] or not release["published_at"]:
        return []
    tag = release["tag_name"]
    published = release["published_at"]
    if not STAMP.fullmatch(published):
        raise ValueError(f"invalid release publication time for {repository}/{tag}")
    base = f"https://github.com/{repository}/releases"
    nightly_version = re.search(
        rf"^\*\*ROCm Version\*\*:\s*({VERSION}(?:(?:a|rc)[0-9]{{8}})?)\s*$",
        release.get("body") or "",
        re.MULTILINE,
    )
    assets = {
        asset["name"]: asset
        for asset in release["assets"]
        if asset["state"] == "uploaded" and asset["size"] > 0
    }
    by_version = {}
    for name in sorted(assets):
        if channel == "stable":
            match = re.fullmatch(
                rf"llama-{re.escape(tag)}-bin-(?:ubuntu|win)-rocm-({VERSION})-x64\.(?:zip|tar\.gz)",
                name,
            )
            version = match[1] if match else None
        else:
            match = re.fullmatch(
                rf"llama-{re.escape(tag)}-(?:ubuntu|windows)-rocm-gfx[0-9a-zA-Z]+-x64\.zip",
                name,
            )
            if match and not nightly_version:
                raise ValueError(f"missing nightly ROCm version for {repository}/{tag}")
            version = nightly_version[1] if match else None
        if version is None:
            continue
        download = f"{base}/download/{quote(tag, safe='')}/"
        archive = {"name": name, "url": download + quote(name, safe="")}
        stem = name.removesuffix(".tar.gz").removesuffix(".zip")
        report = f"qualification-{stem}.json"
        if report in assets:
            archive["attached_report"] = download + quote(report, safe="")
        by_version.setdefault(version, []).append(archive)
    return [
        dict(
            repository=repository,
            channel=channel,
            tag=tag,
            version=version,
            published_at=published,
            url=f"{base}/tag/{quote(tag, safe='')}",
            archives=archives,
        )
        for version, archives in sorted(by_version.items())
    ]


def discover(repositories, nightly_limit, fetch, previous=None, *, today=None):
    today = today or datetime.now(timezone.utc).date()
    inventory = {}
    heads = {}
    for channel, repository in repositories.items():
        api = f"https://api.github.com/repos/{repository}/releases"
        old_head = (previous or {}).get("heads", {}).get(channel)
        if (
            old_head
            and old_head["repository"] == repository
            and old_head.get("full_scan")
            and 0 <= (today - date.fromisoformat(old_head["full_scan"])).days < 7
        ):
            for row in previous["releases"]:
                if row["channel"] == channel and row["repository"] == repository:
                    inventory.setdefault((channel, row["tag"]), []).append(row)
        else:
            old_head = None
        observed = {}
        page = 1
        while True:
            releases = fetch(f"{api}?per_page=100&page={page}")
            if not isinstance(releases, list):
                raise ValueError(f"invalid GitHub release page for {repository}")
            if page == 1 and releases:
                heads[channel] = {
                    "repository": repository,
                    "tag": releases[0]["tag_name"],
                    "full_scan": old_head["full_scan"]
                    if old_head
                    else today.isoformat(),
                }
            for release in releases:
                observed[channel, release["tag_name"]] = release_rows(
                    repository, channel, release
                )
            if len(releases) < 100:
                if channel in heads:
                    heads[channel]["full_scan"] = today.isoformat()
                # A full scan can also reconcile deleted historical releases.
                inventory = {
                    key: rows for key, rows in inventory.items() if key[0] != channel
                }
                break
            if old_head and (channel, old_head["tag"]) in observed:
                break
            page += 1
        inventory.update(observed)
    confirmed = set()
    while True:
        rows = [row for key in sorted(inventory) for row in inventory[key]]
        observed = {
            channel: [
                f"{major}.{minor}"
                for major, minor in sorted(
                    {release_minor(row) for row in rows if row["channel"] == channel}
                )
            ]
            for channel in repositories
        }
        selected = select_releases(rows, nightly_limit)
        pending = [
            row for row in selected if (row["channel"], row["tag"]) not in confirmed
        ]
        if not pending:
            print(
                "Readiness release tracks observed: " + json.dumps(observed), flush=True
            )
            return {"schema_version": 1, "heads": heads, "releases": rows}, selected
        for row in pending:
            channel, tag = row["channel"], row["tag"]
            if (channel, tag) in confirmed:
                continue
            repository = repositories[channel]
            url = f"https://api.github.com/repos/{repository}/releases/tags/{quote(tag, safe='')}"
            try:
                release = fetch(url)
                if release["tag_name"] != tag:
                    raise ValueError(
                        f"GitHub returned an unexpected tag for {repository}/{tag}"
                    )
                inventory[channel, tag] = release_rows(repository, channel, release)
            except HTTPError as error:
                if error.code != 404:
                    raise
                inventory.pop((channel, tag), None)
            confirmed.add((channel, tag))


def match_archive(row, source, release, archive):
    return (
        source["repository"] == release["repository"]
        and row["channel"] == release["channel"]
        and row.get("tag") == release["tag"]
        and row.get("published") is not False
        and bool(row.get("report_url"))
        and (row.get("producer_rocm_version") or row["rocm_version"])
        == release["version"]
        and row.get("artifact") == archive["name"]
    )


def qualify(selected, builds, sources, fetch):
    by_id = {source["id"]: source for source in sources}
    result = []
    for release in selected:
        archives = []
        for archive in release["archives"]:
            archive = {**archive}
            matches = [
                row
                for row in builds
                if match_archive(row, by_id[row["source_id"]], release, archive)
            ]
            if matches:
                row = max(
                    matches,
                    key=lambda item: (
                        item["generated_at"],
                        item.get("run_attempt") or 0,
                        item["build_id"],
                    ),
                )
                archive.update(
                    qualification_build_id=row["build_id"],
                    qualification_source_id=row["source_id"],
                    report_url=row["report_url"],
                    qualified=row["qualified"],
                    overall=row["overall"],
                )
            elif report_url := archive.get("attached_report"):
                try:
                    report = fetch(report_url)
                    build = report["build"]
                    if (
                        (
                            build.get("release_tag")
                            or build.get("llamacpp_tag")
                            or build.get("tag")
                        )
                        != release["tag"]
                        or build["artifact"] != archive["name"]
                        or build["rocm_version"] != release["version"]
                        or type(report["qualified"]) is not bool
                        or (
                            report.get("overall") is not None
                            and not isinstance(report["overall"], str)
                        )
                    ):
                        raise ValueError(
                            "qualification report identity or outcome mismatch"
                        )
                    archive.update(
                        report_url=report_url,
                        qualified=report["qualified"],
                        overall=report.get("overall"),
                    )
                except (
                    OSError,
                    ValueError,
                    KeyError,
                    TypeError,
                    AttributeError,
                ) as error:
                    print(
                        f"Readiness qualification unavailable: {report_url}: {error}",
                        flush=True,
                    )
            archives.append(archive)
        result.append({**release, "archives": archives})
        coverage = sum(bool(archive.get("report_url")) for archive in archives)
        print(
            f"Readiness release selected: {release['channel']} {release['version']} "
            f"{release['repository']} {release['tag']} qualification={coverage}/{len(archives)}",
            flush=True,
        )
    return result


def validate_inventory(inventory, repositories=None):
    if inventory["schema_version"] != 1 or not isinstance(inventory["releases"], list):
        raise ValueError("invalid release inventory")
    heads = inventory["heads"]
    for channel, head in heads.items():
        if (
            channel not in {"stable", "nightly"}
            or not REPOSITORY.fullmatch(head["repository"])
            or (
                repositories is not None and repositories[channel] != head["repository"]
            )
            or not isinstance(head["tag"], str)
            or not head["tag"]
            or date.fromisoformat(head["full_scan"]).isoformat() != head["full_scan"]
        ):
            raise ValueError("invalid release inventory pagination marker")
    seen = set()
    for row in inventory["releases"]:
        channel, repository, tag, version = (
            row["channel"],
            row["repository"],
            row["tag"],
            row["version"],
        )
        key = channel, tag, version
        suffix = "" if channel == "stable" else r"(?:(?:a|rc)[0-9]{8})?"
        base = f"https://github.com/{repository}/releases"
        tag_path = quote(tag, safe="")
        if (
            key in seen
            or heads[channel]["repository"] != repository
            or not re.fullmatch(VERSION + suffix, version)
            or not STAMP.fullmatch(row["published_at"])
            or row["url"] != f"{base}/tag/{tag_path}"
            or not isinstance(row["archives"], list)
            or not row["archives"]
        ):
            raise ValueError("invalid release inventory entry")
        seen.add(key)
        archives = {}
        for archive in row["archives"]:
            name = archive["name"]
            if name in archives:
                raise ValueError("duplicate release archive")
            archives[name] = archive
        names = list(archives)
        names.extend(
            archive["attached_report"].rsplit("/", 1)[-1]
            for archive in archives.values()
            if "attached_report" in archive
        )
        expected = release_rows(
            repository,
            channel,
            {
                "draft": False,
                "published_at": row["published_at"],
                "tag_name": tag,
                "body": f"**ROCm Version**: {version}",
                "assets": [dict(name=name, state="uploaded", size=1) for name in names],
            },
        )
        if expected != [row]:
            raise ValueError("invalid release inventory archive mapping")
    return inventory["releases"]

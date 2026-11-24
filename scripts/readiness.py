"""Resolve the app's current ROCm tracks from validated producer records."""

from datetime import timedelta
import re


RETENTION_DAYS = 14


def window_start(today):
    return today - timedelta(days=RETENTION_DAYS - 1)


def track(version):
    if not isinstance(version, str) or not re.fullmatch(
        r"[0-9]+(?:\.[0-9]+)+", version
    ):
        raise ValueError("invalid ROCm version for readiness selection")
    return ".".join(str(int(part)) for part in version.split(".")[:2])


def select_policy(policy, builds):
    """An explicit anchor remains supported for historical/custom consumers."""
    if policy is None or policy.get("stable_anchor") != "latest":
        return policy
    stable = {row["rocm_version"] for row in builds if row["channel"] == "stable"}
    if not stable:
        raise ValueError(
            "latest stable track is unavailable in current producer evidence"
        )
    key = lambda value: tuple(int(part) for part in value.split("."))
    anchor = max(stable, key=key)
    # Choose minor tracks, preserving the producer's numeric version used by
    # package attribution and execution completeness. Do not rewrite 10.3.0 to
    # 10.3. Within a minor track, the newest numeric SDK version wins.
    by_track = {}
    for row in builds:
        value = row["rocm_version"]
        minor = track(value)
        if row["channel"] != "nightly" or key(minor) <= key(track(anchor)):
            continue
        if minor not in by_track or key(value) > key(by_track[minor]):
            by_track[minor] = value
    nightly = [
        by_track[minor]
        for minor in sorted(by_track, key=key)[: policy["nightly_limit"]]
    ]
    return {"stable_anchor": anchor, "tracks": [anchor, *nightly]}


def numeric_version(value):
    return re.split(r"a|rc", value, maxsplit=1)[0]


def release_version_key(release):
    return tuple(map(int, numeric_version(release["version"]).split(".")))


def release_minor(release):
    return release_version_key(release)[:2]


def select_releases(releases, nightly_limit, *, stable_since=None):
    latest = {"stable": {}, "nightly": {}}
    for release in releases:
        by_minor = latest[release["channel"]]
        minor = release_minor(release)
        key = lambda row: (
            row["published_at"],
            row["tag"],
            release_version_key(row),
            row["version"],
        )
        if minor not in by_minor or key(release) > key(by_minor[minor]):
            by_minor[minor] = release
    if not latest["stable"]:
        raise ValueError("release discovery found no published stable ROCm binaries")
    anchor = max(latest["stable"])
    stable_tracks = {anchor}
    if stable_since is not None:
        # Keep a former stable only while it was the latest stable within the
        # retained calendar window. Older, concurrently shipped SDKs do not qualify.
        events = {}
        cutoff = stable_since.isoformat() + "T00:00:00Z"
        for release in releases:
            if release["channel"] == "stable":
                when = max(release["published_at"], cutoff)
                minor = release_minor(release)
                events[when] = max(events.get(when, minor), minor)
        newest = ()
        for when in sorted(events):
            newest = max(newest, events[when])
            stable_tracks.add(newest)
    nightly = latest["nightly"]
    return [
        *[latest["stable"][minor] for minor in sorted(stable_tracks)],
        *[nightly[minor] for minor in sorted(nightly) if minor > anchor][
            :nightly_limit
        ],
    ]


def release_policy(selected):
    tracks = [numeric_version(row["version"]) for row in selected]
    stable = [numeric_version(row["version"]) for row in selected if row["channel"] == "stable"]
    policy = {"stable_anchor": stable[-1], "tracks": tracks}
    if len(stable) > 1:
        policy["historical_stable_tracks"] = stable[:-1]
    return policy

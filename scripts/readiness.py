"""Resolve the app's current ROCm tracks from validated producer records."""

import re


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

"""Collector-owned presentation for qualification results; verdict tokens stay intact."""
import re

# Visible wording has a single production source, independent of UI fallback copy.
NO_HARDWARE_LABEL = "no hardware available"


def qualification_labels(build):
    labels = {"tiers": {}, "checks": {}}
    if build.get("hardware_validated") is not False:
        return labels
    tiers = {key: value for key, value in build.items()
             if re.fullmatch(r"tier\d+", key, re.IGNORECASE)}
    if isinstance(build.get("tier_verdicts"), dict):
        tiers.update(build["tier_verdicts"])
    for tier, verdict in tiers.items():
        if tier.lower() == "tier1" and verdict == "not_applicable":
            labels["tiers"][tier] = NO_HARDWARE_LABEL
    results = build.get("results")
    for check, verdict in (results if isinstance(results, dict) else {}).items():
        if re.fullmatch(r"T1(?:\.\d+)+", check, re.IGNORECASE) and verdict == "not_applicable":
            labels["checks"][check] = NO_HARDWARE_LABEL
    return labels

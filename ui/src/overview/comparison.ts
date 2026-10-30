import type { Build } from "../data";

// Compare distinct packages, not reruns of the currently displayed package.
// Ambiguous ordering and first-in-series cases deliberately have no comparison.
export function previousBuild(
  current: Build,
  history: Build[] | null,
): Build | null {
  if (!current.tag || !current.source_id || !history) return null;
  const candidates = history
    .filter(
      (row) =>
        row.engine === current.engine &&
        row.source_id === current.source_id &&
        row.os === current.os &&
        row.gfx_target === current.gfx_target &&
        (!current.artifact || row.artifact !== current.artifact) &&
        row.channel === current.channel &&
        row.rocm_version === current.rocm_version &&
        row.tag &&
        row.tag !== current.tag &&
        row.build_id !== current.build_id &&
        Date.parse(row.generated_at) < Date.parse(current.generated_at),
    )
    .sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at));
  if (!candidates.length) return null;
  const first = candidates[0];
  if (
    candidates.some(
      (row, index) =>
        index > 0 &&
        Date.parse(row.generated_at) === Date.parse(first.generated_at),
    )
  )
    return null;
  return first;
}

export function checkChanges(current: Build, previous: Build) {
  if (
    !current.results ||
    !previous.results ||
    !Object.keys(current.results).length ||
    !Object.keys(previous.results).length
  )
    return null;
  const transitions: { from: string; to: string; count: number }[] = [];
  for (const [id, to] of Object.entries(current.results)) {
    const from = previous.results[id];
    if (from === undefined || from === to) continue;
    const group = transitions.find(
      (entry) => entry.from === from && entry.to === to,
    );
    if (group) group.count++;
    else transitions.push({ from, to, count: 1 });
  }
  return {
    transitions,
    added: Object.keys(current.results).filter(
      (id) => !(id in previous.results!),
    ).length,
    removed: Object.keys(previous.results).filter(
      (id) => !(id in current.results!),
    ).length,
  };
}

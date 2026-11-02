import type { Build } from "../data";
type Source = { id: string; stale_after_hours?: number | null };
type Freshness = {
  status: "fresh" | "stale" | "unknown";
  staleSources: {
    sourceId: string;
    ageHours: number;
    thresholdHours: number;
  }[];
};
export function reportFreshness(
  builds: Build[],
  sources: Source[],
  now: number,
): Freshness {
  const latest = new Map<string, number>();
  let unknown = !builds.length;
  for (const build of builds) {
    if (!build.source_id) {
      unknown = true;
      continue;
    }
    latest.set(
      build.source_id,
      Math.max(
        latest.get(build.source_id) ?? -Infinity,
        Date.parse(build.generated_at),
      ),
    );
  }
  const staleSources: Freshness["staleSources"] = [];
  for (const [sourceId, timestamp] of latest) {
    const threshold = sources.find(
      (source) => source.id === sourceId,
    )?.stale_after_hours;
    if (!threshold || !Number.isFinite(timestamp) || timestamp > now) {
      unknown = true;
      continue;
    }
    const ageHours = (now - timestamp) / 3_600_000;
    if (ageHours > threshold)
      staleSources.push({ sourceId, ageHours, thresholdHours: threshold });
  }
  return {
    status: staleSources.length ? "stale" : unknown ? "unknown" : "fresh",
    staleSources,
  };
}

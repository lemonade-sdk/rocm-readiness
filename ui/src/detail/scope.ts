import type { Build } from "../data";

export function scopeBuilds(builds: Build[], params: URLSearchParams): Build[] {
  return builds.filter(
    (build) =>
      (!params.get("engine") || build.engine === params.get("engine")) &&
      (!params.get("channel") || build.channel === params.get("channel")) &&
      (!params.get("build") || build.build_id === params.get("build")) &&
      (!params.get("source") || build.source_id === params.get("source")) &&
      (!params.get("date") ||
        new Date(build.generated_at).toISOString().slice(0, 10) ===
          params.get("date")),
  );
}

export function resetScope(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.set("view", "engine");
  for (const key of [
    "build",
    "source",
    "platform",
    "channel",
    "date",
    "build_filter",
    "model",
    "system",
    "workload",
    "compare",
  ])
    next.delete(key);
  return next;
}

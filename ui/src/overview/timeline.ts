import type { Build } from "../data";
export type DailyStatus =
  | "qualified"
  | "failed"
  | "warning"
  | "unknown"
  | "no-report";
export type Day = { date: string; status: DailyStatus; builds: Build[] };
export const statusLabels: Record<DailyStatus, string> = {
  qualified: "Qualified",
  failed: "Not qualified",
  warning: "Qualified with warnings",
  unknown: "Qualification unknown",
  "no-report": "No qualification record",
};
export const statusSymbols: Record<DailyStatus, string> = {
  qualified: "●",
  failed: "×",
  warning: "!",
  unknown: "?",
  "no-report": "—",
};
export function dailyTimeline(
  builds: Build[],
  end: string,
  count: number,
): Day[] {
  const last = new Date(end);
  last.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(last.getTime() - (count - index - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const rows = builds.filter(
      (build) =>
        new Date(build.generated_at).toISOString().slice(0, 10) === date,
    );
    const status: DailyStatus = !rows.length
      ? "no-report"
      : rows.some((build) => build.qualified === false)
        ? "failed"
        : rows.some((build) => build.qualified == null)
          ? "unknown"
          : rows.some(
                (build) => build.overall === "warn" || build.overall === "fail",
              )
            ? "warning"
            : "qualified";
    return { date, status, builds: rows };
  });
}
export function dayHref(build: Build, date: string, days?: number): string {
  return `?${new URLSearchParams({ view: "engine", version: build.rocm_version, engine: build.engine, channel: build.channel, platform: build.os, date, ...(days ? { days: String(days) } : {}) })}`;
}
export function dayLabel(day: Day): string {
  const skipped = day.builds.reduce(
    (sum, build) => sum + (build.tests?.skipped ?? 0),
    0,
  );
  const missing = day.builds.reduce(
    (sum, build) => sum + (build.tests?.missing ?? 0),
    0,
  );
  return `${day.date} UTC: ${statusLabels[day.status]}; ${day.builds.length} qualification records${skipped ? `; ${skipped} skipped checks` : ""}${missing ? `; ${missing} missing checks` : ""}`;
}

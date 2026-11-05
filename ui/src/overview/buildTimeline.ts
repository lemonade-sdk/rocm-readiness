import type { Build } from "../data";

export const READINESS_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export function buildDate(build: Build): string {
  return new Date(build.generated_at).toISOString().slice(0, 10);
}

export function calendarDays(now: Date): string[] {
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Array.from({ length: READINESS_WINDOW_DAYS }, (_, index) =>
    new Date(end - (READINESS_WINDOW_DAYS - index - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10),
  );
}

export function qualificationOutcome(build: Build): "pass" | "fail" | null {
  if (build.qualified === true) return "pass";
  if (build.qualified === false) return "fail";
  return null;
}

export function exactBuildHref(build: Build, view = "build-review"): string {
  const query = new URLSearchParams({
    view,
    version: build.rocm_version,
    engine: build.engine,
    channel: build.channel,
    platform: build.os,
    build: build.build_id,
  });
  if (build.source_id) query.set("source", build.source_id);
  return `?${query}`;
}

export function buildIdentity(build: Build): string {
  return JSON.stringify([
    build.source_id,
    build.engine,
    build.rocm_version,
    build.channel,
    build.os,
    build.build_id,
    build.gfx_target,
  ]);
}

const calendarMonthLabel = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

export function calendarMonthGroups(days: readonly string[]) {
  const months: { key: string; label: string; days: number }[] = [];
  for (const day of days) {
    const key = day.slice(0, 7);
    const previous = months.at(-1);
    if (previous?.key === key) previous.days++;
    else months.push({ key, label: calendarMonthLabel.format(new Date(day)), days: 1 });
  }
  return months;
}

export function isCalendarMonthBoundary(days: readonly string[], index: number) {
  return index > 0 && days[index].slice(0, 7) !== days[index - 1].slice(0, 7);
}

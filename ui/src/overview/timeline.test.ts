import { expect, it } from "vitest";
import type { Build } from "../data";
import { overview } from "../fixtures";
import { dailyTimeline, dayHref } from "./timeline";
const base = overview().engines[0].latest_builds[0] as Build;
const build = (patch: Partial<Build> = {}): Build => ({
  ...base,
  generated_at: "2026-10-29T12:00:00Z",
  ...patch,
});
it("keeps every same-day identity and does not hide a failure behind a later pass", () => {
  const rows = [
    build({ build_id: "failed", qualified: false }),
    build({ build_id: "passed" }),
  ];
  const days = dailyTimeline(rows, "2026-10-30T12:00:00Z", 2);
  expect(days.map((day) => day.status)).toEqual(["failed", "no-report"]);
  expect(days[0].builds.map((row) => row.build_id)).toEqual([
    "failed",
    "passed",
  ]);
  expect(rows).toHaveLength(2);
});
it("distinguishes warning and unknown qualification without turning skipped checks into failures", () => {
  for (const patch of [{ overall: "warn" }, { overall: "fail" }])
    expect(dailyTimeline([build(patch)], "2026-10-29Z", 1)[0].status).toBe(
      "warning",
    );
  expect(
    dailyTimeline([build({ qualified: null })], "2026-10-29Z", 1)[0].status,
  ).toBe("unknown");
  expect(
    dailyTimeline(
      [
        build({
          tests: { passed: 1, failed: 0, skipped: 1, missing: 2, total: 4 },
        }),
      ],
      "2026-10-29Z",
      1,
    )[0].status,
  ).toBe("qualified");
});
it("uses UTC report dates, crosses months and leaves days with no report empty", () => {
  const days = dailyTimeline(
    [build({ generated_at: "2026-11-01T00:30:00+02:00" })],
    "2026-11-01T01:00:00Z",
    3,
  );
  expect(days.map((day) => day.date)).toEqual([
    "2026-10-30",
    "2026-10-31",
    "2026-11-01",
  ]);
  expect(days.map((day) => day.builds.length)).toEqual([0, 1, 0]);
});
it("unknown reports prevent a green rollup even alongside qualified reports", () => {
  expect(
    dailyTimeline(
      [build(), build({ build_id: "unknown", qualified: null })],
      "2026-10-29Z",
      1,
    )[0].status,
  ).toBe("unknown");
});
it("drills into all builds in a date scope rather than selecting an arbitrary identity", () => {
  const query = new URLSearchParams(dayHref(base, "2026-10-29").slice(1));
  expect(Object.fromEntries(query)).toEqual({
    view: "engine",
    version: "10.1",
    engine: "llamacpp",
    channel: "stable",
    platform: "linux",
    date: "2026-10-29",
  });
});
it("preserves the chosen window in daily drill-down URLs", () => {
  expect(
    new URLSearchParams(dayHref(base, "2026-10-29", 30).slice(1)).get("days"),
  ).toBe("30");
});
it("does not invent an overall warning when a qualified archive has no overall field", () => {
  expect(
    dailyTimeline([build({ overall: null })], "2026-10-29Z", 1)[0].status,
  ).toBe("qualified");
});

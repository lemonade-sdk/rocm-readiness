import { expect, it } from "vitest";
import type { Build } from "../data";
import { overview } from "../fixtures";
import { reportFreshness } from "./freshness";
const base = overview().engines[0].latest_builds[0] as Build;
const now = Date.parse("2026-10-30T12:00:00Z");
const sources = [
  { id: "llamacpp-stable-qualification", stale_after_hours: 72 },
];
it("checks each OS independently rather than borrowing the latest other-platform report", () => {
  expect(
    reportFreshness(
      [{ ...base, generated_at: "2026-10-30T11:00:00Z" }],
      sources,
      now,
    ).status,
  ).toBe("fresh");
  expect(
    reportFreshness(
      [{ ...base, os: "windows", generated_at: "2026-10-26T12:00:00Z" }],
      sources,
      now,
    ),
  ).toMatchObject({
    status: "stale",
    staleSources: [
      { sourceId: base.source_id, ageHours: 96, thresholdHours: 72 },
    ],
  });
});
it("uses the configured threshold and latest report for each source", () => {
  expect(
    reportFreshness(
      [
        { ...base, generated_at: "2026-10-20T12:00:00Z" },
        { ...base, generated_at: "2026-10-27T12:00:00Z" },
      ],
      sources,
      now,
    ).status,
  ).toBe("fresh");
  expect(
    reportFreshness(
      [{ ...base, generated_at: "2026-10-27T11:59:59Z" }],
      sources,
      now,
    ).status,
  ).toBe("stale");
});
it("does not infer a freshness threshold or ignore an older independent source", () => {
  expect(reportFreshness([base], [], now).status).toBe("unknown");
  expect(
    reportFreshness([{ ...base, source_id: null }], sources, now).status,
  ).toBe("unknown");
  expect(
    reportFreshness(
      [
        { ...base, generated_at: "2026-10-30T11:00:00Z" },
        { ...base, source_id: "other", generated_at: "2026-10-26T12:00:00Z" },
      ],
      [...sources, { id: "other", stale_after_hours: 24 }],
      now,
    ).status,
  ).toBe("stale");
});
it("ages retained evidence against the current clock without changing the archive outcome", () => {
  const build = { ...base, generated_at: "2026-10-27T12:00:00Z" };
  expect(reportFreshness([build], sources, now).status).toBe("fresh");
  expect(reportFreshness([build], sources, now + 3600000).status).toBe("stale");
  expect(build.qualified).toBe(true);
});
it("keeps nullable or zero thresholds unknown", () => {
  for (const stale_after_hours of [null, 0])
    expect(
      reportFreshness([base], [{ id: base.source_id!, stale_after_hours }], now)
        .status,
    ).toBe("unknown");
});

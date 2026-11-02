import type { Build } from "../data";
import { expect, it } from "vitest";
import { overview } from "../fixtures";
import { resetScope, scopeBuilds } from "./scope";
import { scopedAttempts } from "./ExecutionEvidence";
import { executionAttempt } from "../fixtures";

it("keeps exact source, channel, engine and UTC date rather than matching repeated tags", () => {
  const build = overview().engines[0].latest_builds[0] as Build;
  const params = new URLSearchParams({
    engine: build.engine,
    source: build.source_id!,
    channel: "stable",
    build: build.build_id,
    date: new Date(build.generated_at).toISOString().slice(0, 10),
  });
  expect(
    scopeBuilds(
      [
        build,
        { ...build, source_id: "other" },
        { ...build, channel: "nightly" },
      ],
      params,
    ),
  ).toEqual([build]);
  expect(resetScope(params).get("engine")).toBe(build.engine);
  expect(resetScope(params).has("build")).toBe(false);
  expect(resetScope(params).has("date")).toBe(false);
});
it("does not attach an old metricless failed attempt to a newer selected build", () => {
  const build = overview().engines[0].latest_builds[0] as Build;
  const attempt = executionAttempt();
  const params = new URLSearchParams({
    build: build.build_id,
    source: build.source_id!,
    platform: "linux",
  });
  expect(scopedAttempts([attempt], params, [build])).toEqual([]);
  expect(scopedAttempts([attempt], new URLSearchParams(), [build])).toEqual([
    attempt,
  ]);
});
it("rejects an ambiguous or different package even when the build identifier is equal", () => {
  const build: Build = {
    ...(overview().engines[0].latest_builds[0] as Build),
    source_url: undefined,
  };
  const attempt = {
    ...executionAttempt(),
    qualification_build_id: build.build_id,
    engine_version: build.tag!,
    model: "metricless failure",
  };
  const params = new URLSearchParams({ build: build.build_id });
  expect(scopedAttempts([attempt], params, [build])).toEqual([attempt]);
  expect(
    scopedAttempts([attempt], params, [
      build,
      { ...build, source_id: "other" },
    ]),
  ).toEqual([]);
  expect(
    scopedAttempts([{ ...attempt, engine_version: "older" }], params, [build]),
  ).toEqual([]);
});
it("retains exact attempts across multiple builds in a source/date scope", () => {
  const build = {
    ...(overview().engines[0].latest_builds[0] as Build),
    source_url: undefined,
  };
  const other = { ...build, build_id: "other", tag: "b-other" };
  const attempt = {
    ...executionAttempt(),
    qualification_build_id: build.build_id,
    engine_version: build.tag!,
  };
  const second = {
    ...attempt,
    qualification_build_id: other.build_id,
    engine_version: other.tag,
  };
  expect(
    scopedAttempts(
      [attempt, second],
      new URLSearchParams({ source: build.source_id! }),
      [build, other],
    ),
  ).toEqual([attempt, second]);
});

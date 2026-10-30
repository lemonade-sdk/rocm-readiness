import { expect, it } from "vitest";
import type { Build } from "../data";
import { previousBuild, checkChanges } from "./comparison";
const current: Build = {
  build_id: "latest",
  tag: "b2",
  engine: "llamacpp",
  source_id: "stable",
  channel: "stable",
  os: "linux",
  rocm_version: "10.1",
  generated_at: "2026-10-30T12:00:00Z",
  qualified: true,
  results: { a: "pass", b: "missing" },
};
const before: Build = {
  ...current,
  build_id: "previous",
  tag: "b1",
  generated_at: "2026-10-29T12:00:00Z",
  results: { a: "pass", b: "pass" },
};
it("selects the preceding package in the same source/version/platform/channel", () => {
  expect(
    previousBuild(current, [
      before,
      {
        ...before,
        build_id: "wrong",
        rocm_version: "10.0",
        generated_at: "2026-10-30T11:00:00Z",
      },
      {
        ...before,
        build_id: "rerun",
        tag: "b2",
        generated_at: "2026-10-30T10:00:00Z",
      },
    ]),
  ).toEqual(before);
  expect(
    previousBuild(current, [
      { ...before, os: "windows" },
      { ...before, gfx_target: "gfx1151" },
      { ...before, source_id: "other" },
      { ...before, generated_at: current.generated_at },
    ]),
  ).toBeNull();
});
it("does not arbitrarily choose between tied predecessor reports", () => {
  expect(
    previousBuild(current, [before, { ...before, build_id: "tie", tag: "b0" }]),
  ).toBeNull();
});
it("reports observed transitions and separately counts coverage changes", () => {
  expect(checkChanges(current, before)).toEqual({
    transitions: [{ from: "pass", to: "missing", count: 1 }],
    added: 0,
    removed: 0,
  });
  expect(
    checkChanges({ ...current, results: { a: "pass", c: "pass" } }, before),
  ).toEqual({ transitions: [], added: 1, removed: 1 });
  expect(checkChanges({ ...current, results: null }, before)).toBeNull();
});

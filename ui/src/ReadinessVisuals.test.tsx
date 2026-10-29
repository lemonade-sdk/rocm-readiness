import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { BuildQualification, PlatformChecks } from "./ReadinessVisuals";
import { overview } from "./fixtures";
import type { Build } from "./data";
it("shows partial check counts without inventing warning or skipped values", () => {
  const base = overview().engines[0].latest_builds[0] as Build;
  render(
    <PlatformChecks
      build={{
        ...base,
        tests: { passed: 16, failed: 0, total: 17 } as Build["tests"],
      }}
    />,
  );
  expect(screen.getByText("16 / 17")).toBeInTheDocument();
  expect(
    screen.getByText("Detailed check breakdown unavailable"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("counts a qualified build with warnings as qualified without calling its checks a clean pass", () => {
  const base = overview().engines[0].latest_builds[0] as Build;
  render(
    <BuildQualification
      builds={[
        base,
        { ...base, build_id: "warn", overall: "warn" },
        { ...base, build_id: "unknown", qualified: null, overall: null },
      ]}
      total={3}
      error={null}
    />,
  );
  expect(screen.getByText("2 / 3")).toBeInTheDocument();
  expect(
    screen.getByRole("img", {
      name: /1 clean pass, 1 with warnings, 0 failed, 1 unknown/,
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("1 qualification unknown")).toBeInTheDocument();
});
it("shows empty history without a success percentage", () => {
  render(<BuildQualification builds={[]} total={0} error={null} />);
  expect(screen.getByText("No builds")).toBeInTheDocument();
  expect(screen.queryByText("100%")).not.toBeInTheDocument();
});
it("shows check counts with skips in the denominator", () => {
  const base = overview().engines[0].latest_builds[0] as Build;
  render(
    <PlatformChecks
      build={{
        ...base,
        tests: {
          passed: 13,
          failed: 0,
          warned: 1,
          skipped: 3,
          missing: 0,
          total: 17,
        },
      }}
    />,
  );
  expect(screen.getByText("13 / 17")).toBeInTheDocument();
  expect(
    screen.getByRole("img", {
      name: /13 passed, 1 warnings, 0 failed, 3 skipped, 0 missing/,
    }),
  ).toBeInTheDocument();
});
it("does not invent passing checks when a breakdown is absent", () => {
  render(
    <PlatformChecks build={overview().engines[0].latest_builds[0] as Build} />,
  );
  expect(screen.getByText("Check breakdown unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
it("keeps the compiled-target visual proportional for large target sets", () => {
  const base = overview().engines[0].latest_builds[0] as Build;
  render(
    <PlatformChecks
      build={{ ...base, gfx: { present: 50, requested: 100, missing: [] } }}
    />,
  );
  const chart = screen.getByRole("img", {
    name: "50 of 100 requested GPU targets compiled",
  });
  expect(chart.querySelectorAll(".present").length * 2).toBe(
    chart.children.length,
  );
});

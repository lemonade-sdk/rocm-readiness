import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import type { Build } from "../data";
import type { PerformanceData } from "./PerformanceView";
import { matchedPerformanceObservations, PerformancePreview } from "./PerformancePreview";

const build: Build = {
  build_id: "linux-package", source_id: "qualification", engine: "llamacpp",
  channel: "stable", tag: "b100", rocm_version: "10.1", os: "linux",
  generated_at: "2026-11-10T00:00:00Z", run_id: "100",
};
const row: PerformanceData["measurements"][number] = {
  source_id: "benchmark", engine: "llamacpp", channel: "stable", backend: "rocm",
  model: "Model A", scenario: "chat", measured_at: "2026-11-10T01:00:00Z",
  metrics: { ttft_ms_mean: 1000, tps_mean: 10 },
};

it("shows proportional bars and marks an unmeasured OS unavailable", async () => {
  render(<MemoryRouter><PerformancePreview heading="b100" observations={[
    { build, row },
    { build, row: { ...row, model: "Model B", metrics: { ttft_ms_mean: 2000, tps_mean: 20 } } },
  ]} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Performance data for b100" }));
  const popup = await screen.findByRole("dialog");
  const windows = within(popup).getByRole("button", { name: /^Windows$/ });
  expect(windows).toBeDisabled();
  expect(windows).toHaveAttribute("title", "Unavailable");
  expect(within(popup).getByRole("button", { name: /^Linux$/ })).toHaveAttribute("aria-pressed", "true");
  const ttft = within(popup).getByRole("group", { name: "Model A · TTFT" });
  expect(ttft).toHaveTextContent("1 s");
  expect(ttft.querySelector(".performance-chart-fill")).toHaveStyle({ width: "50%" });
  expect(within(popup).getByText("Higher is better")).toBeInTheDocument();
  expect(within(popup).queryByText("VRAM")).not.toBeInTheDocument();
});

it("groups only the same qualification run and GPU family across operating systems", () => {
  const windows = { ...build, build_id: "windows-package", os: "windows" };
  const otherRun = { ...windows, build_id: "other-run", run_id: "101" };
  const otherFamily = { ...windows, build_id: "other-family", gfx_family: "gfx120X" };
  const matches = new Map<Build, PerformanceData["measurements"]>();
  for (const item of [build, windows, otherRun, otherFamily]) matches.set(item, [row]);
  expect(matchedPerformanceObservations([build], matches).map((item) => item.build))
    .toEqual([build, windows]);
});

it("does not infer a shared run when legacy build records lack run IDs", () => {
  const linux = { ...build, run_id: undefined };
  const windows = { ...linux, os: "windows", build_id: "windows-package" };
  const matches = new Map([[linux, [row]], [windows, [row]]]);
  expect(matchedPerformanceObservations([linux], matches).map((item) => item.build)).toEqual([linux]);
});

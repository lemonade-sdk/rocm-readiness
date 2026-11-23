import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Sync } from "./data";
import { fixtureFetch, index, indexUrl, pointer } from "./fixtures";
import { upstreamFetch } from "./upstream/fixtures";

const pointerUrl = "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json";
const failure: Sync = {
  status: "failed", attempted_at: "2026-11-02T11:04:45.069582+00:00",
  last_successful_at: "2026-10-29T11:04:54.663841+00:00",
  errors: [{ source_id: "lemonade-performance", record: "/by_model_scenario/K2-Horizon-0.9B-GGUF|context-4k/3",
    field: "package_evidence", reason: "run=44854194006 engine=b12576: benchmark job evidence access failed (exit 1, HTTP 404); authenticated GitHub log access may be required" }],
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function mount(sync = failure, track = "readiness", extra: Record<string, unknown> = {}) {
  const overrides = { [pointerUrl]: { ...pointer, sync }, ...extra };
  return render(<MemoryRouter initialEntries={[track === "upstream" ? "/?track=upstream" : "/"]}>
    <App fetcher={track === "upstream" ? upstreamFetch(overrides) : fixtureFetch(overrides)} />
  </MemoryRouter>);
}

async function openMissingDay(track: string, day = "2026-11-02") {
  if (track === "upstream") {
    const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
    fireEvent.click(within(calendar).getByRole("button", { name: `${day}: No observation` }));
  } else {
    const control = await screen.findByRole("button", { name: `${day} UTC · ROCm 10.1 stable · Linux · No observation` });
    fireEvent.click(control);
  }
  return screen.findByRole("dialog");
}

it.each(["readiness", "upstream"])("explains dashboard-wide benchmark collection context only inside the %s empty-day tooltip", async track => {
  mount(failure, track);
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("region", { name: "Dashboard data couldn’t be updated" })).not.toBeInTheDocument();
  expect(screen.queryByText(/which software build was tested/)).not.toBeInTheDocument();
  const tooltip = await openMissingDay(track);
  expect(within(tooltip).getByText("Dashboard update", { selector: "dt" })).toBeVisible();
  expect(within(tooltip).getByText(/which software build was tested \(HTTP 404\)/)).toBeVisible();
  expect(tooltip).toHaveTextContent("K2-Horizon-0.9B-GGUF");
  expect(tooltip).toHaveTextContent("b12576");
  expect(within(tooltip).getByRole("link", { name: "Benchmark run" })).toHaveAttribute("href", "https://github.com/lemonade-sdk/lemonade/actions/runs/44854194006");
  expect(within(tooltip).getByRole("link", { name: "Lemonade benchmark leaderboard" })).toHaveAttribute("href", "https://github.com/lemonade-sdk/lemonade/blob/benchmark-data/leaderboard.json");
  expect(within(tooltip).queryByText("Finding", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(tooltip).queryByText("Collected", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(tooltip).getByText("Last update attempt", { selector: "dt" })).toBeVisible();
});

it("keeps an older empty date free of unrelated collection context", async () => {
  mount();
  const tooltip = await openMissingDay("readiness", "2026-10-28");
  expect(within(tooltip).getByText("No qualification result collected for this date.")).toBeVisible();
  expect(within(tooltip).queryByText("Dashboard update", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(tooltip).queryByRole("link", { name: "Benchmark run" })).not.toBeInTheDocument();
});

it("does not add collection context to a recorded healthy build", async () => {
  mount();
  const healthy = (await screen.findAllByRole("link", { name: /Open package qualification.*· Qualified(?: ·|$)/ }))[0];
  fireEvent.focus(healthy);
  const tooltip = await screen.findByRole("dialog");
  expect(within(tooltip).getByText("Produced", { selector: "dt" })).toBeVisible();
  expect(within(tooltip).queryByText("Dashboard update", { selector: "dt" })).not.toBeInTheDocument();
});

it("keeps unknown collection failures honest without inventing links", async () => {
  const reason = "run=123 https://malicious.invalid/ — unexpected source response";
  mount({ ...failure, errors: [{ source_id: "unrecognized", field: "feed", record: "/item", reason }] });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).getByText("Dashboard update", { selector: "dt" })).toBeVisible();
  expect(tooltip).toHaveTextContent(reason);
  expect(within(tooltip).queryByRole("link")).not.toBeInTheDocument();
});

it("does not fabricate a run link for a malformed run identifier", async () => {
  mount({ ...failure, errors: [{ ...failure.errors[0], reason: failure.errors[0].reason.replace("44854194006", "44854194006evil") }] });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).queryByRole("link", { name: "Benchmark run" })).not.toBeInTheDocument();
});

it("ignores a failed attempt older than the active dataset", async () => {
  mount(failure, "readiness", { [indexUrl]: { ...index, generated_at: "2026-11-02T12:00:00Z" } });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).queryByText("Dashboard update", { selector: "dt" })).not.toBeInTheDocument();
});

it("does not add failure context after a successful collection", async () => {
  mount({ ...failure, status: "success", errors: [], last_successful_at: failure.attempted_at });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).queryByText("Dashboard update", { selector: "dt" })).not.toBeInTheDocument();
});

it("handles missing last-success metadata without claiming a successful dataset", async () => {
  mount({ ...failure, last_successful_at: null, errors: [] });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).getByText("Dashboard update", { selector: "dt" })).toBeVisible();
  expect(tooltip).not.toHaveTextContent("Showing the last successful dataset");
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { syncSchema, type Finding, type Sync } from "./data";
import { fixtureFetch, index, indexUrl, pointer } from "./fixtures";
import { upstreamFetch } from "./upstream/fixtures";

const pointerUrl = "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json";
const failure: Sync = {
  status: "failed", attempted_at: "2026-11-02T11:04:45Z", last_successful_at: "2026-10-29T11:04:54Z",
  errors: [{ source_id: "lemonade-performance", record: "", field: "package_evidence", reason: "HTTP 404" }],
};
const benchmark: Finding = {
  id: "collection_failed:1", kind: "collection_failed", applies_to: "missing_observation",
  scopes: [{ date: "2026-11-02", source_id: "llamacpp-stable-qualification" }],
  finding: "Collection attempt failed: Lemonade's published benchmark links to a GitHub run the dashboard couldn't read (HTTP 404).",
  status: "A later collection attempt on this date succeeded.",
  evidence: [{ label: "Benchmark run", url: "https://github.com/lemonade-sdk/lemonade/actions/runs/44854194006" }],
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function mount(findings: Finding[], track = "readiness", extra: Record<string, unknown> = {}) {
  const overrides = { [pointerUrl]: { ...pointer, findings }, ...extra };
  return render(<MemoryRouter initialEntries={[track === "upstream" ? "/?track=upstream" : "/"]}>
    <App fetcher={track === "upstream" ? upstreamFetch(overrides) : fixtureFetch(overrides)} />
  </MemoryRouter>);
}

async function openMissingDay(track: string, day = "2026-11-02") {
  if (track === "upstream") {
    const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
    fireEvent.focus(within(calendar).getByRole("button", { name: `${day}: No observation` }));
  } else {
    fireEvent.click(await screen.findByRole("button", { name: `${day} UTC · ROCm 10.1 stable · Linux · No observation` }));
  }
  return screen.findByRole("dialog");
}

it("renders a published finding, its status, and evidence in the empty cell it names", async () => {
  mount([benchmark]);
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).getAllByRole("term").map(term => term.textContent)).toEqual(["Finding", "Status", "Evidence"]);
  expect(within(tooltip).getByText(benchmark.finding)).toBeVisible();
  expect(within(tooltip).getByText(benchmark.status!)).toBeVisible();
  expect(tooltip).not.toHaveTextContent("No qualification result collected for this date.");
  expect(within(tooltip).getByRole("link", { name: "Benchmark run" })).toHaveAttribute("href", benchmark.evidence[0].url);
});

it.each([
  ["another source", { ...benchmark, scopes: [{ date: "2026-11-02", source_id: "sdcpp-stable-qualification" }] }],
  ["another date", { ...benchmark, scopes: [{ date: "2026-11-01", source_id: "llamacpp-stable-qualification" }] }],
])("does not show a finding published for %s", async (_, finding) => {
  mount([finding]);
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).getAllByRole("term").map(term => term.textContent)).toEqual(["Finding"]);
  expect(within(tooltip).getByText("No qualification result collected for this date.")).toBeVisible();
});

it("shows a date-only finding on every empty cell of that date, including upstream", async () => {
  mount([{ ...benchmark, status: undefined, evidence: [], scopes: [{ date: "2026-11-02" }],
    finding: "No new dashboard data: the dashboard update could not be published." }], "upstream");
  const tooltip = await openMissingDay("upstream");
  expect(tooltip).toHaveTextContent("No new dashboard data: the dashboard update could not be published.");
  expect(tooltip).not.toHaveTextContent("No run collected for this date.");
});

it("uses findings recorded in the index when the pointer carries none", async () => {
  mount([], "readiness", { [pointerUrl]: pointer, [indexUrl]: { ...index, findings: [benchmark] } });
  const tooltip = await openMissingDay("readiness");
  expect(within(tooltip).getByText(benchmark.finding)).toBeVisible();
});

it("does not add missing-observation findings to a recorded build", async () => {
  mount([{ ...benchmark, scopes: [{ date: "2026-11-02" }] }]);
  const healthy = (await screen.findAllByRole("link", { name: /Open package qualification.*· Qualified(?: ·|$)/ }))[0];
  fireEvent.focus(healthy);
  const tooltip = await screen.findByRole("dialog");
  expect(within(tooltip).getByText("Produced", { selector: "dt" })).toBeVisible();
  expect(tooltip).not.toHaveTextContent(benchmark.finding);
});

it("rejects malformed and future attempt history while accepting legacy sync", () => {
  expect(syncSchema.parse(failure)).toEqual(failure);
  for (const attempts of [[{}], [{ ...failure, attempted_at: "2026-11-03T11:00:00Z" }],
    [{ ...failure, status: "success" }]]) {
    expect(syncSchema.safeParse({ ...failure, attempts }).success).toBe(false);
  }
});

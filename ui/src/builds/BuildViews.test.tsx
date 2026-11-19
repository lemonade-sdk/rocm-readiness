import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineBuilds } from "./BuildViews";
import { buildFixture, session } from "./fixtures";
import type { PerformanceData } from "../performance/PerformanceView";

const { useMeasurements } = vi.hoisted(() => ({ useMeasurements: vi.fn() }));
vi.mock("./useBuildMeasurements", () => ({ useBuildMeasurements: useMeasurements }));
const measured = buildFixture({ build_id: "measured", tag: "b100", run_id: "run-measured" });
const sibling = buildFixture({ build_id: "measured-windows", tag: "b100", run_id: "run-measured", os: "windows" });
const unmatched = buildFixture({ build_id: "unmeasured", tag: "b101", run_id: "run-unmeasured" });
const expired = buildFixture({ build_id: "expired", tag: "expired-build", generated_at: "2026-10-19T23:59:59Z" });
const history = [measured, sibling, unmatched, expired];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T15:00:00Z")); });
afterEach(() => vi.useRealTimers());
const row = { model: "Model A", measured_at: "2026-10-29T02:00:00Z" } as PerformanceData["measurements"][number];

function mount(query = "view=engine&version=10.1&through=2026-10-29", unavailable = false) {
  const retry = vi.fn();
  useMeasurements.mockReturnValue(unavailable ? { matches: new Map(), message: "Model performance unavailable", retry }
    : { matches: new Map([[measured, [row]]]), message: "" });
  const navigate = vi.fn();
  function Harness() {
    const [params, setParams] = useState(new URLSearchParams(query));
    return <EngineBuilds session={session} history={history} params={params} fetcher={vi.fn()}
      versionFilter={<span>ROCm 10.1</span>} onNavigate={(next) => { navigate(next); setParams(next); }} />;
  }
  render(<MemoryRouter><Harness /></MemoryRouter>);
  return navigate;
}

describe("Build qualification performance filter", () => {
  it("preserves the performance retry when the active filter cannot load measurements", () => {
    mount("view=engine&through=2026-10-29&performance=measured", true);
    expect(screen.getByRole("status")).toHaveTextContent("Model performance unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry performance" }));
    expect(useMeasurements.mock.results.at(-1)?.value.retry).toHaveBeenCalledOnce();
  });
  it("toggles matched observations through URL state", () => {
    const navigate = mount();
    const toggle = screen.getByRole("button", { name: "Measured" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByText("b101").length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(navigate.mock.lastCall?.[0].get("performance")).toBe("measured");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryAllByText("b101")).toHaveLength(0);
    expect(screen.getAllByText("b100").length).toBeGreaterThan(0);
    fireEvent.click(toggle);
    expect(navigate.mock.lastCall?.[0].has("performance")).toBe(false);
    expect(screen.getAllByText("b101").length).toBeGreaterThan(0);
  });
  it("honors URL state, matches same-run platform siblings, and resets", () => {
    const navigate = mount("view=engine&version=10.1&through=2026-10-29&performance=measured&platform=windows");
    expect(screen.getByRole("button", { name: "Measured" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryAllByText("b101")).toHaveLength(0);
    expect(screen.getAllByText("b100").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    const params = navigate.mock.lastCall?.[0];
    expect(params.has("performance")).toBe(false);
    expect(params.has("platform")).toBe(false);
    expect(params.get("version")).toBe("10.1");
    expect(params.has("through")).toBe(false);
    expect(screen.getAllByText("b101").length).toBeGreaterThan(0);
  });
});

afterEach(() => vi.unstubAllGlobals());
it("keeps date-scoped phone packages visible without a platform filter", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  mount("view=engine&version=10.1&day=2026-10-29");
  const evidence = document.querySelectorAll(".qualification-day-evidence");
  expect(evidence).toHaveLength(2);
  expect(screen.getAllByRole("heading", { name: /^Package qualification$/ })).toHaveLength(2);
  const toggles = document.querySelectorAll<HTMLButtonElement>('.qualification-day-toggle[aria-expanded="true"]');
  fireEvent.click(toggles[1]);
  expect(document.querySelectorAll(".qualification-day-evidence")).toHaveLength(0);
});

it("ignores historical paging URLs and excludes packages outside the current fourteen dates", () => {
  mount("view=engine&version=10.1&through=2026-10-19");
  expect(screen.queryByRole("navigation", { name: "Browse qualification dates" })).not.toBeInTheDocument();
  expect(screen.queryByText("expired-build")).not.toBeInTheDocument();
  expect(screen.getAllByText("b100").length).toBeGreaterThan(0);
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QualificationMatrix } from "./QualificationMatrix";
import { buildFixture, producerReport } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

it("shows phone package records and expands check evidence outside the check strip", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const build = buildFixture({ results: { "T0.1": "fail" }, tier_verdicts: { tier0: "fail" }, report_url: undefined });
  render(<QualificationMatrix builds={[build]} selected={null} fetcher={vi.fn()} />);
  const card = screen.getByRole("article", { name: `${build.tag} · Linux` });
  fireEvent.click(within(card).getByRole("button", { name: "T0.1 · Fail" }));
  const evidence = within(card).getByRole("region", { name: "T0.1 · Fail" });
  expect(evidence).toHaveTextContent("Package");
  expect(evidence.closest(".qualification-check-strip")).toBeNull();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("opens phone package evidence when navigation selects an already mounted package", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const build = buildFixture({ report_url: undefined });
  const fetcher = vi.fn();
  const { rerender } = render(<QualificationMatrix builds={[build]} selected={null} fetcher={fetcher} />);
  expect(screen.queryByRole("region", { name: `Package details for ${build.tag}` })).not.toBeInTheDocument();
  rerender(<QualificationMatrix builds={[build]} selected={build} openPackage fetcher={fetcher} />);
  expect(screen.getByRole("region", { name: `Package details for ${build.tag}` })).toBeVisible();
  rerender(<QualificationMatrix builds={[build]} selected={null} fetcher={fetcher} />);
  expect(screen.queryByRole("region", { name: `Package details for ${build.tag}` })).not.toBeInTheDocument();
});

it("shows ROCm once and places legends beneath their stable build sections", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<QualificationMatrix builds={[buildFixture({ tag: "b100", build_id: "a", run_id: "1" }), buildFixture({ tag: "b101", build_id: "b", run_id: "2" })]} selected={null} fetcher={vi.fn()} />);
  expect(screen.getAllByRole("heading", { name: "ROCm 10.1" })).toHaveLength(1);
  const section = screen.getByRole("region", { name: "Build b100" });
  expect(within(section).getByRole("heading", { name: "b100" })).toBeVisible();
  const legend = within(section).getByRole("list", { name: "Check outcomes" });
  expect(section.lastElementChild).toBe(legend);
});

it("uses GPU family headings and scoped legends for phone nightly packages", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<QualificationMatrix builds={[
    buildFixture({ tag: "b100", build_id: "a", run_id: "1", channel: "nightly", gfx_family: "gfx110X" }),
    buildFixture({ tag: "b100", build_id: "b", run_id: "1", channel: "nightly", gfx_family: "gfx115X" }),
    buildFixture({ tag: "b101", build_id: "c", run_id: "2", channel: "nightly", gfx_family: "gfx110X" }),
  ]} selected={null} fetcher={vi.fn()} />);
  for (const family of ["gfx110X", "gfx115X"]) {
    const group = screen.getByRole("region", { name: `GPU family ${family}` });
    expect(within(group).getByRole("heading", { name: family })).toBeVisible();
    expect(group.lastElementChild).toBe(within(group).getByRole("list", { name: "Check outcomes" }));
  }
});

it.each(["llama-test.tar.gz", "llama-test.zip"])("links a published %s archive and formats its produced time", async (artifact) => {
  const build = buildFixture({ artifact, published: true, generated_at: "2026-11-11T12:34:56Z", report_url: undefined });
  render(<QualificationMatrix builds={[build]} selected={build} openPackage fetcher={vi.fn()} />);
  const popup = await screen.findByRole("dialog");
  expect(within(popup).getByRole("heading", { name: /Linux.*Qualified/ })).toBeVisible();
  expect(popup.querySelector(".qualification-platform-heading .build-tooltip-status")).toHaveTextContent("Qualified");
  expect(within(popup).queryByText("Dataset revision", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(popup).queryByText("ROCm SDK", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(popup).queryByText("Qualification", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(popup).getByText("Upstream SHA", { selector: "dt" })).toBeVisible();
  const archive = within(popup).getByRole("link", { name: artifact });
  expect(archive).toHaveAttribute("href", `https://github.com/lemonade-sdk/llama.cpp/releases/download/${build.tag}/${artifact}`);
  expect(popup).toHaveTextContent("November 11, 2026 at 12:34:56 UTC");
});

it("does not link an archive that did not ship", async () => {
  const build = buildFixture({ published: false, report_url: undefined });
  render(<QualificationMatrix builds={[build]} selected={build} openPackage fetcher={vi.fn()} />);
  const popup = await screen.findByRole("dialog");
  expect(within(popup).queryByRole("link", { name: build.artifact! })).not.toBeInTheDocument();
  expect(popup).toHaveTextContent(build.artifact!);
});

it("puts a shared qualification source above the platform groups and keeps separate report rows", async () => {
  const linux = buildFixture({ build_id: "linux" });
  const windows = buildFixture({ build_id: "windows", os: "windows" });
  render(<QualificationMatrix builds={[linux, windows]} selected={linux} openPackage fetcher={vi.fn()} />);
  const popup = await screen.findByRole("dialog");
  const source = within(popup).getByRole("link", { name: "View data source" });
  expect(source).toHaveAttribute("href", linux.source_url);
  expect(source.closest(".qualification-popup-packages")).toBeNull();
  const reports = within(popup).getAllByRole("link", { name: "View record source" });
  expect(reports.map((link) => link.getAttribute("href"))).toEqual([windows.report_url, linux.report_url]);
  for (const link of reports) {
    expect(link.closest("dl")).toHaveTextContent("Qualification record");
    expect(link.closest("li")).not.toContainElement(source);
  }
});

it("renders collector qualification labels verbatim without relabeling other outcomes", async () => {
  const build = Object.assign(buildFixture({ hardware_validated: false, report_url: undefined,
    tier_verdicts: { tier0: "not_applicable", tier1: "not_applicable" },
    results: { "T0.11": "not_applicable", "T1.1": "not_applicable", "T1.2": "skip" },
  }), { qualification_labels: { tiers: { tier1: "Collector hardware explanation" },
    checks: { "T1.1": "Collector hardware explanation" } } });
  render(<QualificationMatrix builds={[build]} selected={null} fetcher={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "T1.1 · Collector hardware explanation" });
  fireEvent.focus(trigger);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Collector hardware explanation");
  expect(screen.getByRole("button", { name: "T0.11 · Not applicable" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "T1.2 · Skipped" })).toBeInTheDocument();
  expect(screen.getByLabelText("Tier 1 · Collector hardware explanation")).toBeInTheDocument();
});

it("keeps legacy qualification labels when presentation fields are absent", () => {
  const build = buildFixture({ hardware_validated: false, report_url: undefined,
    tier_verdicts: { tier1: "not_applicable" }, results: { "T1.1": "not_applicable" },
  });
  render(<QualificationMatrix builds={[build]} selected={null} fetcher={vi.fn()} />);
  expect(screen.getByRole("button", { name: "T1.1 · Not applicable" })).toBeInTheDocument();
});

it("does not reuse compact not-applicable labels for skipped or failed report outcomes", async () => {
  const build = Object.assign(buildFixture({ hardware_validated: false,
    tier_verdicts: { tier1: "not_applicable" }, results: { "T1.1": "not_applicable" },
  }), { qualification_labels: { tiers: { tier1: "Collector hardware explanation" },
    checks: { "T1.1": "Collector hardware explanation" } } });
  const report = producerReport(build, { tiers: { tier1: {
    tier_name: "Runtime", status: "skip", tests: [
      { id: "T1.1", name: "Skipped attempt", status: "skip" },
      { id: "T1.1", name: "Failed attempt", status: "fail" },
      { id: "T1.1", name: "Unattempted check", status: "not_applicable" },
    ],
  } } });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(report)));
  render(<QualificationMatrix builds={[build]} selected={null} fetcher={fetcher} />);
  fireEvent.focus(screen.getByRole("button", { name: "T1.1 · Collector hardware explanation" }));
  expect(await screen.findByRole("button", { name: "T1.1 · Skipped" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "T1.1 · Fail" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "T1.1 · Collector hardware explanation" })).toBeInTheDocument();
  expect(screen.getByLabelText("Tier 1 · Skipped")).toBeInTheDocument();
});

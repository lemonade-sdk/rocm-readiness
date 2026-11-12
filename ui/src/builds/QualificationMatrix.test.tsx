import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QualificationMatrix } from "./QualificationMatrix";
import { buildFixture } from "./fixtures";

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

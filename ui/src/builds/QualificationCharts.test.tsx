import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QualificationCharts } from "./QualificationCharts";

afterEach(() => vi.unstubAllGlobals());
it("expands an empty phone day inside its own dated row", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<QualificationCharts builds={[]} track="stable" days={["2026-11-02"]} platforms={["linux"]} />);
  fireEvent.click(screen.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux" }));
  const evidence = screen.getByRole("region", { name: "2026-11-02 UTC · 0 packages · Linux" });
  expect(evidence).toHaveTextContent("No packages recorded");
  expect(screen.getByText("2026-11-02").closest("li")).toContainElement(evidence);
});

it("uses dated horizontal bars on narrow phones", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const { container } = render(<QualificationCharts builds={[]} track="stable" days={["2026-11-02"]} platforms={["linux"]} />);
  expect(screen.getByText("2026-11-02")).toBeVisible();
  expect(container.querySelector(".qualification-trend-stack")).toHaveAttribute("data-horizontal", "true");
});

it("opens package details inside a populated phone date row", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<QualificationCharts builds={[]} track="stable" days={["2026-11-02"]} platforms={["linux"]}
    renderDay={() => <p>Package evidence here</p>} />);
  const toggle = screen.getByRole("button", { name: "2026-11-02 UTC · 0 packages · Linux" });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle.closest("li")).toContainElement(screen.getByText("Package evidence here"));
  fireEvent.click(toggle);
  expect(screen.queryByText("Package evidence here")).not.toBeInTheDocument();
});

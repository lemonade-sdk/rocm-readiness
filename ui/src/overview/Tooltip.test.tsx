import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip, TooltipContent, tooltipTiming } from "./Tooltip";
import { EvidenceRegion } from "./EvidenceRegion";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("expands phone evidence in flow on activation, without hover or focus opening", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<Tooltip label="Package details" content={<a href="#report">Pinned report</a>}>Build b100</Tooltip>);
  const trigger = screen.getByRole("button", { name: "Package details" });
  fireEvent.mouseEnter(trigger);
  act(() => trigger.focus());
  expect(screen.queryByRole("region", { name: "Package details" })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("region", { name: "Package details" })).toContainElement(screen.getByRole("link", { name: "Pinned report" }));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

it("reflects selected check evidence in the card disclosure and collapses it from that control", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(<EvidenceRegion>
    <Tooltip label="Check T0.1" content="Check evidence">✓</Tooltip>
    <Tooltip mobilePrimary label="Package evidence" content="Package metadata">Evidence &amp; configuration</Tooltip>
  </EvidenceRegion>);
  fireEvent.click(screen.getByRole("button", { name: "Check T0.1" }));
  const summary = screen.getByRole("button", { name: "Package evidence" });
  expect(summary).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", { name: "Close evidence" })).not.toBeInTheDocument();
  fireEvent.click(summary);
  expect(summary).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("region", { name: "Check T0.1" })).not.toBeInTheDocument();
});

it("keeps phone evidence expanded when using other page controls", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const changed = vi.fn();
  render(<Tooltip label="Selected day" initialOpen onOpenChange={changed} content="Run evidence">27</Tooltip>);
  fireEvent.pointerDown(document.body);
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Selected day" })).toBeVisible();
});
it("delays opening and cancels incidental pointer passes", async () => {
  vi.useFakeTimers();
  render(
    <Tooltip label="Compare readiness" content="Still qualified">
      Qualified
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "Compare readiness" });
  fireEvent.mouseEnter(trigger);
  await act(() => vi.advanceTimersByTimeAsync(tooltipTiming.openDelayMs - 1));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.mouseLeave(trigger);
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.mouseEnter(trigger);
  await act(() => vi.advanceTimersByTimeAsync(tooltipTiming.openDelayMs));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Still qualified");
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
it("supports keyboard focus and click/touch disclosure", async () => {
  render(
    <Tooltip label="Compare checks" content="Two checks changed">
      Checks passed
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "Compare checks" });
  act(() => trigger.focus());
  await screen.findByRole("tooltip");
  expect(trigger).toHaveAttribute(
    "aria-describedby",
    screen.getByRole("tooltip").id,
  );
  act(() => trigger.blur());
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  fireEvent.click(trigger);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.click(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("anchors an interactive popup with an arrow and supports outside dismissal", async () => {
  render(<Tooltip interactive label="Package details" content={<a href="#report">Linux report</a>}>Build</Tooltip>);
  fireEvent.click(screen.getByRole("button", { name: "Package details" }));
  const popup = await screen.findByRole("dialog", { name: "Package details" });
  expect(popup.querySelector(".tooltip-arrow")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Linux report" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close popup" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Package details" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Package details" }));
  await screen.findByRole("dialog");
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("defaults to shared evidence rows and explicitly supports custom visualizations", () => {
  const { container, rerender } = render(<TooltipContent heading="CI run"><dl><dt>Outcome</dt><dd>Failed</dd></dl></TooltipContent>);
  expect(container.querySelector(".structured-tooltip-body")).toHaveAttribute("data-format", "details");
  rerender(<TooltipContent heading="Model performance" format="custom"><figure>Comparison chart</figure></TooltipContent>);
  expect(container.querySelector(".structured-tooltip-body")).toHaveAttribute("data-format", "custom");
});

it("uses only the styled tooltip by default", async () => {
  const { container } = render(<Tooltip label="Status" content="Status explanation">partial</Tooltip>);
  fireEvent.focus(screen.getByRole("button", { name: "Status" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Status explanation");
  expect(container.querySelector("[title]")).toBeNull();
});
it("uses only the native tooltip when system mode is explicit", () => {
  render(<Tooltip tooltipMode="system" systemText="Native explanation" label="Status" content="Styled explanation">partial</Tooltip>);
  const trigger = screen.getByRole("button", { name: "Status" });
  expect(trigger).toHaveAttribute("title", "Native explanation");
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

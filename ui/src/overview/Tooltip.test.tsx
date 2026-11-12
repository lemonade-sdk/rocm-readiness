import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip, TooltipContent, tooltipTiming } from "./Tooltip";
afterEach(() => vi.useRealTimers());
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

it("keeps a tooltip open when a tap focuses the trigger before clicking", () => {
  render(<Tooltip label="Filter help" content="Filter scope">Help</Tooltip>);
  const trigger = screen.getByRole("button", { name: "Filter help" });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Filter scope");
  fireEvent.click(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

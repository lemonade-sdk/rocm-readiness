import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Tooltip, tooltipTiming } from "./Tooltip";
afterEach(() => vi.useRealTimers());
it("delays opening and cancels incidental pointer passes", () => {
  vi.useFakeTimers();
  render(
    <Tooltip label="Compare readiness" content="Still qualified">
      Qualified
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "Compare readiness" });
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(tooltipTiming.openDelayMs - 1));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.pointerLeave(trigger);
  act(() => vi.advanceTimersByTime(10));
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.pointerEnter(trigger);
  act(() => vi.advanceTimersByTime(tooltipTiming.openDelayMs));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Still qualified");
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
it("supports keyboard focus and click/touch disclosure", () => {
  vi.useFakeTimers();
  render(
    <Tooltip label="Compare checks" content="Two checks changed">
      Checks passed
    </Tooltip>,
  );
  const trigger = screen.getByRole("button", { name: "Compare checks" });
  fireEvent.focus(trigger);
  act(() => vi.advanceTimersByTime(tooltipTiming.openDelayMs));
  expect(trigger).toHaveAttribute(
    "aria-describedby",
    screen.getByRole("tooltip").id,
  );
  fireEvent.blur(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.click(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeControl } from "./ThemeControl";

const listeners = new Set<(event: { matches: boolean }) => void>();
function system(dark: boolean) {
  const query = {
    matches: dark,
    addEventListener: (
      _: string,
      callback: (event: { matches: boolean }) => void,
    ) => listeners.add(callback),
    removeEventListener: (
      _: string,
      callback: (event: { matches: boolean }) => void,
    ) => listeners.delete(callback),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return (matches: boolean) =>
    act(() => {
      query.matches = matches;
      listeners.forEach((callback) => callback({ matches }));
    });
}
function choose(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Change color theme" }));
  fireEvent.click(screen.getByRole("button", { name }));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  listeners.clear();
  document.documentElement.removeAttribute("data-theme");
});
it("follows changes to the device theme by default", () => {
  const changeSystem = system(true);
  render(<ThemeControl />);
  expect(
    screen.getByRole("button", { name: "Change color theme" }),
  ).toHaveAttribute("title", "Theme: System (Dark)");
  changeSystem(false);
  expect(
    screen.getByRole("button", { name: "Change color theme" }),
  ).toHaveAttribute("title", "Theme: System (Light)");
  expect(document.documentElement.dataset.theme).toBe("system");
});
it("persists overrides and returns to automatic behavior", () => {
  const changeSystem = system(false);
  render(<ThemeControl />);
  choose("Dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("rocm-readiness-theme")).toBe("dark");
  changeSystem(true);
  changeSystem(false);
  expect(document.documentElement.dataset.theme).toBe("dark");
  choose("System");
  expect(localStorage.getItem("rocm-readiness-theme")).toBeNull();
  expect(document.documentElement.dataset.theme).toBe("system");
});
it("restores a saved override and dismisses options with Escape", () => {
  system(true);
  localStorage.setItem("rocm-readiness-theme", "light");
  render(<ThemeControl />);
  const button = screen.getByRole("button", { name: "Change color theme" });
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(button);
  expect(
    screen.getByRole("button", { name: "Light", pressed: true }),
  ).toBeInTheDocument();
  fireEvent.keyDown(document.body, {
    key: "Escape",
  });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveFocus();
});
it("ignores invalid saved values and survives unavailable storage", () => {
  system(false);
  localStorage.setItem("rocm-readiness-theme", "invalid");
  const first = render(<ThemeControl />);
  expect(document.documentElement.dataset.theme).toBe("system");
  first.unmount();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Blocked");
  });
  render(<ThemeControl />);
  choose("Dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});

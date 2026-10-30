import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { EngineOverview } from "./EngineOverview";
import { fixtureFetch, indexUrl, historyFixture } from "./fixtures";
import { loadSession } from "./data";

it("groups engines inside descending ROCm versions with a fixed timeline and latest-day highlight", async () => {
  const fetcher = fixtureFetch();
  const session = await loadSession(undefined, fetcher);
  render(
    <MemoryRouter>
      <EngineOverview session={session} fetcher={fetcher} onRetry={() => {}} />
    </MemoryRouter>,
  );
  const scope = await screen.findByRole("region", {
    name: "llama.cpp ROCm 10.1 stable",
  });
  await screen.findByRole("region", { name: "llama.cpp ROCm 10.0 stable" });
  expect(screen.getAllByRole("heading", { name: "llama.cpp" })).toHaveLength(2);
  expect(
    within(scope).getByRole("rowheader", { name: /Linux/ }),
  ).toBeInTheDocument();
  expect(
    within(scope).getByRole("rowheader", { name: /Windows/ }),
  ).toBeInTheDocument();
  expect(within(scope).getAllByRole("columnheader")).toHaveLength(15);
  const link = within(scope).getByRole("link", {
    name: /stable linux: 2026-10-29/,
  });
  expect(link).toHaveAttribute(
    "href",
    expect.stringContaining("date=2026-10-29"),
  );
  expect(link).not.toHaveAttribute("href", expect.stringContaining("build="));
  expect(screen.queryByText("b11972")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Timeline window")).not.toBeInTheDocument();
  expect(screen.queryByText(/Each symbol includes/)).not.toBeInTheDocument();
  expect(screen.queryByText(/dataset captured/)).not.toBeInTheDocument();
  const versions = screen.getAllByRole("heading", { level: 2 });
  expect(versions.map((node) => node.textContent)).toEqual([
    "ROCm 10.1",
    "ROCm 10.0",
  ]);
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.1" })).getByRole(
      "heading",
      { name: "llama.cpp" },
    ),
  ).toBeInTheDocument();
  expect(link).not.toHaveClass("health-latest");
  expect(
    within(scope).getByRole("columnheader", {
      name: "2026-10-29 · Latest recorded day",
    }),
  ).toHaveClass("health-latest-date");
});
it("distinguishes a collection error for one version from empty days and keeps other versions", async () => {
  const original = fixtureFetch();
  const fetcher: typeof fetch = async (input, init) =>
    String(input).includes("rocm/10.0/history")
      ? new Response("{}", { status: 503 })
      : original(input);
  const session = await loadSession(undefined, fetcher);
  render(
    <MemoryRouter>
      <EngineOverview session={session} fetcher={fetcher} onRetry={() => {}} />
    </MemoryRouter>,
  );
  await screen.findByRole("region", { name: "llama.cpp ROCm 10.1 stable" });
  expect(await screen.findByRole("alert")).toHaveTextContent("ROCm 10.0");
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503");
  expect(
    screen.getByRole("button", { name: "Retry history" }),
  ).toBeInTheDocument();
});
it("keeps unknown qualification visible and omits unsupported engine placeholders", async () => {
  const history = historyFixture();
  const fetcher = fixtureFetch({
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
      ...history,
      builds: history.builds.map((row) => ({ ...row, qualified: null })),
    },
  });
  const session = await loadSession(undefined, fetcher);
  render(
    <MemoryRouter>
      <EngineOverview session={session} fetcher={fetcher} onRetry={() => {}} />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("link", {
      name: /10.1 stable linux:.*Qualification unknown/,
    }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "vLLM" }),
  ).not.toBeInTheDocument();
});

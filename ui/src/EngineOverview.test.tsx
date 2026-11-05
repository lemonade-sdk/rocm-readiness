import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import type { Build } from "./data";
import { EngineOverview } from "./EngineOverview";
import { overview } from "./fixtures";

const now = new Date("2026-11-02T15:00:00Z");
function build(overrides: Partial<Build> = {}): Build {
  return {
    ...overview().engines[0].latest_builds[0],
    channel: "stable",
    ...overrides,
  };
}
function mount(builds: Build[], history: Build[] | null = builds) {
  const engine = { ...overview().engines[0], latest_builds: builds };
  return render(
    <MemoryRouter>
      <EngineOverview
        version="10.1"
        engines={[engine]}
        history={history}
        now={now}
      />
    </MemoryRouter>,
  );
}

it("renders distinct same-day builds as exact-build links rather than a daily rollup", () => {
  mount([
    build({
      build_id: "first",
      tag: "b1",
      generated_at: "2026-11-01T01:00:00Z",
    }),
    build({
      build_id: "second",
      tag: "b2",
      qualified: false,
      generated_at: "2026-11-01T02:00:00Z",
    }),
  ]);
  const day = screen.getByRole("cell", { name: /b1.*b2/ });
  const links = within(day).getAllByRole("link");
  expect(links).toHaveLength(2);
  expect(links[0]).toHaveAttribute(
    "href",
    expect.stringContaining("build=first"),
  );
  expect(links[1]).toHaveAttribute(
    "href",
    expect.stringContaining("view=build"),
  );
  expect(links[1]).toHaveAttribute(
    "href",
    expect.stringContaining("build=second"),
  );
  expect(links[1]).toHaveAttribute(
    "href",
    expect.stringContaining("platform=linux"),
  );
  expect(links[1]).toHaveAttribute(
    "href",
    expect.stringContaining("source=llamacpp-stable-qualification"),
  );
  expect(links[0]).toHaveAccessibleName(/Qualified/);
  expect(links[1]).toHaveAccessibleName(/Fail/);
});

it("shows only the last fourteen UTC dates and leaves no-build dates empty", () => {
  mount([
    build({
      build_id: "outside",
      tag: "outside",
      generated_at: "2026-10-19T23:59:59Z",
    }),
    build({
      build_id: "edge",
      tag: "edge",
      generated_at: "2026-10-20T00:00:00Z",
    }),
    build({
      build_id: "future",
      tag: "future",
      generated_at: "2026-11-03T00:00:00Z",
    }),
  ]);
  expect(
    screen.queryByRole("link", { name: /outside|future/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /edge/ })).toBeInTheDocument();
  expect(screen.getAllByRole("columnheader")).toHaveLength(17);
  expect(
    screen.getByRole("columnheader", { name: "2026-10-20 UTC" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("columnheader", { name: "2026-10-19 UTC" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getAllByText("No data")).toHaveLength(27);
});

it("keeps unknown evidence neutral and respects explicit qualification despite warnings", () => {
  mount([
    build({
      build_id: "unknown",
      tag: "unknown",
      qualified: null,
      overall: "pass",
    }),
    build({
      build_id: "warning",
      tag: "warning",
      qualified: true,
      overall: "warn",
      tests: { passed: 1, failed: 0, total: 2 },
    }),
  ]);
  expect(
    screen.getByRole("link", { name: /unknown.*Evidence unavailable/ }),
  ).not.toHaveClass("build-mark");
  expect(screen.getByRole("link", { name: /warning.*Qualified with warnings/ })).toHaveClass(
    "build-mark",
    "pass",
  );
  for (const text of ["Compiled GPU targets", "Qualified", "Checks passed"])
    expect(screen.queryByText(text, { exact: true })).not.toBeInTheDocument();
});

it("keeps expected OS rows without report-date annotations and highlights today", () => {
  mount([build()]);
  expect(screen.getByRole("heading", { name: "Windows" })).toBeInTheDocument();
  expect(screen.getByText("No qualification evidence")).toBeInTheDocument();
  expect(screen.queryByText("2026-10-29")).not.toBeInTheDocument();
  expect(screen.queryByText("Before today")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Dates in UTC|No data.*means/),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/latest report/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "2026-11-02 UTC" }),
  ).toHaveAttribute("aria-current", "date");
  expect(
    screen.getByRole("columnheader", { name: "2026-11-01 UTC" }),
  ).not.toHaveAttribute("aria-current");
});

it("does not duplicate latest records when full history arrives", () => {
  const latest = build();
  mount(
    [latest],
    [
      latest,
      build({
        build_id: "older",
        tag: "older",
        generated_at: "2026-10-28T12:00:00Z",
      }),
    ],
  );
  expect(screen.getAllByRole("link", { name: /b11972/ })).toHaveLength(1);
  expect(screen.getByRole("link", { name: /older/ })).toBeInTheDocument();
});

it("discloses unavailable history while preserving known latest evidence", () => {
  mount([build()], null);
  expect(
    screen.getByText(/History loading or unavailable/),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /b11972/ })).toBeInTheDocument();
});

it("omits an entire engine when it has no records", () => {
  mount([]);
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("renders JSON engine identities and only channels with actual records", () => {
  const engine = {
    ...overview().engines[0],
    id: "custom",
    label: "Custom engine",
    channels: ["stable" as const, "nightly" as const],
    latest_builds: [build({ engine: "custom" })],
  };
  render(
    <MemoryRouter>
      <EngineOverview version="10.1" engines={[engine]} now={now} />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole("heading", { name: "Custom engine" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: /Nightly/ }),
  ).not.toBeInTheDocument();
});

it("positions offset timestamps on the UTC calendar date", () => {
  mount([build({ generated_at: "2026-11-01T23:30:00-05:00" })]);
  const linux = screen.getByRole("row", { name: /^Linux/ });
  const today = within(linux).getAllByRole("cell").at(-1)!;
  expect(
    within(today).getByRole("link", { name: /b11972/ }),
  ).toBeInTheDocument();
});

it("does not infer missing OS expectations from a different channel", () => {
  const engine = {
    ...overview().engines[0],
    platforms: [],
    latest_builds: [
      build({ os: "linux", channel: "stable" }),
      build({ os: "windows", channel: "nightly" }),
    ],
  };
  render(
    <MemoryRouter>
      <EngineOverview version="10.1" engines={[engine]} now={now} />
    </MemoryRouter>,
  );
  const stable = within(
    screen.getByRole("region", { name: "llama.cpp stable build history" }),
  );
  const nightly = within(
    screen.getByRole("region", { name: "llama.cpp nightly build history" }),
  );
  expect(
    stable.queryByRole("heading", { name: "Windows" }),
  ).not.toBeInTheDocument();
  expect(
    nightly.queryByRole("heading", { name: "Linux" }),
  ).not.toBeInTheDocument();
});

it("groups calendar days under spanning month headings", () => {
  mount([build()]);
  expect(
    screen.getByRole("columnheader", { name: "October 2026" }),
  ).toHaveAttribute("colspan", "12");
  expect(
    screen.getByRole("columnheader", { name: "November 2026" }),
  ).toHaveAttribute("colspan", "2");
  expect(
    screen.getByRole("columnheader", { name: "2026-11-01 UTC" }),
  ).toHaveTextContent("1");
  expect(
    screen.getByRole("columnheader", { name: "2026-11-01 UTC" }),
  ).toHaveClass("month-boundary");
  expect(
    screen.queryByRole("heading", { name: "ROCm 10.1 · Stable" }),
  ).not.toBeInTheDocument();
});

it("uses a formatted custom tooltip on the build link without a native title", () => {
  vi.useFakeTimers();
  try {
    mount([
      build({
        generated_at: "2026-10-28T00:47:16Z",
        upstream_sha: "a".repeat(40),
      }),
    ]);
    const link = screen.getByRole("link", { name: /linux-build/ });
    expect(link).not.toHaveAttribute("title");
    fireEvent.focus(link);
    act(() => vi.advanceTimersByTime(400));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("28 Oct 2026, 00:47:16 UTC");
    expect(tooltip).toHaveTextContent("Revision");
    expect(tooltip).toHaveTextContent("Source feed did not report a build result");
    expect(tooltip).toHaveTextContent("Source feed did not report whether this archive shipped");
    expect(tooltip).toHaveTextContent("aaaaaaaaaaaa");
    expect(link).toHaveAttribute("aria-describedby", tooltip.id);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps qualification separate from an explicit build result and publication", async () => {
  mount([build({ qualified: true, overall: "warn", build_result: "pass", published: false })]);
  const link = screen.getByRole("link", { name: /Qualified with warnings/ });
  fireEvent.focus(link);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Build jobpass");
  expect(tooltip).toHaveTextContent("Did not ship in this run");
  expect(link).toHaveClass("pass");
});

it("shows the last nightly result per OS and day even when an earlier result passed", () => {
  mount([
    build({ channel: "nightly", build_id: "linux-latest", qualified: false,
      generated_at: "2026-11-01T02:00:00Z" }),
    build({ channel: "nightly", build_id: "linux-earlier", qualified: true,
      generated_at: "2026-11-01T01:00:00Z" }),
    build({ channel: "nightly", build_id: "linux-prior-day", qualified: true,
      generated_at: "2026-10-31T02:00:00Z" }),
    build({ channel: "nightly", build_id: "windows-latest", os: "windows", qualified: true,
      generated_at: "2026-11-01T01:00:00Z" }),
  ]);

  expect(screen.getByRole("link", { name: /2 nightly builds on 2026-11-01.*latest Failed/ }))
    .toHaveAttribute("href", expect.stringContaining("day=2026-11-01"));
  expect(screen.getByRole("link", { name: /linux-prior-day.*Qualified/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /windows-latest.*Qualified/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /linux-earlier/ })).not.toBeInTheDocument();
});

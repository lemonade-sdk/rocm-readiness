import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReadinessOverview } from "./ReadinessOverview";
import {
  fixtureFetch,
  indexUrl,
  overview,
  historyFixture,
  index,
  pointer,
} from "./fixtures";
import type { Session } from "./data";

// Match the retained build fixtures while leaving async/UI timers real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T15:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function mount(catalog: unknown, fixtures: Record<string, unknown> = {}) {
  const session = {
    pointer,
    index: catalog,
    indexUrl,
    version: null,
    overview: null,
  } as Session;
  return render(
    <MemoryRouter>
      <ReadinessOverview
        session={session}
        fetcher={fixtureFetch(fixtures)}
        onRetry={() => {}}
      />
    </MemoryRouter>,
  );
}

it("renders supplied catalog order without choosing a release anchor or filtering versions", async () => {
  const versions = ["10.1", "10.2", "10.10"];
  const fixtures: Record<string, unknown> = {};
  for (const version of versions) {
    fixtures[new URL(`rocm/${version}/overview.json`, indexUrl).href] =
      overview(version);
    fixtures[new URL(`rocm/${version}/history/2026-10.json`, indexUrl).href] =
      historyFixture(version);
  }
  mount(
    {
      ...index,
      readiness: { stable_anchor: "10.1" },
      versions: versions.map((v) => ({
        rocm_version: v,
        overview: `rocm/${v}/overview.json`,
        build_count: 1,
      })),
    },
    fixtures,
  );
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest Stable" });
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual(["ROCm 10.1 · Latest Stable", "ROCm 10.2 · Nightly", "ROCm 10.10 · Nightly"]);
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.2" })).getByRole(
      "heading",
      { name: "llama.cpp" },
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Pass: producer qualified")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("keeps other supplied tracks visible when one fails", async () => {
  mount(index, { [new URL("rocm/10.2/overview.json", indexUrl).href]: {} });
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest Stable" });
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.2" })).getByRole(
      "alert",
    ),
  ).toBeInTheDocument();
});

it("labels legacy scope honestly and renders its supplied order without inventing an anchor", async () => {
  mount({ ...index, readiness: undefined });
  await screen.findByRole("heading", { name: "ROCm 10.1" });
  expect(
    screen.getByText(/older dataset does not declare/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: /Latest Stable/ }),
  ).not.toBeInTheDocument();
});

it("keeps the overview focused on qualification even when benchmark evidence exists", async () => {
  const o = overview();
  const result = mount(
    { ...index, versions: [index.versions[0]] },
    {
      [new URL("rocm/10.1/overview.json", indexUrl).href]: {
        ...o,
        execution: {
          path: "rocm/10.1/executions.json",
          attempt_count: 1,
          summaries: [],
        },
      },
    },
  );
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest Stable" });
  expect(
    result.container.querySelector(".build-mark.pass"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Bench fail|Benchmark execution|Inspect benchmark/),
  ).not.toBeInTheDocument();
  expect(result.container.querySelector(".build-benchmark-issue")).toBeNull();
});

it("shows a published track when qualification records are unavailable", async () => {
  const releaseUrl = "https://github.com/lemonade-sdk/llamacpp-rocm/releases/tag/b1352";
  const archiveUrl = "https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b1352/archive.zip";
  mount({
    ...index,
    versions: [{
      ...index.versions[1],
      build_count: 0,
      release: {
        tag: "b1352",
        version: "10.2.0a20261022",
        url: releaseUrl,
        published_at: "2026-10-22T15:19:29Z",
        archives: [{ name: "archive.zip", url: archiveUrl }],
      },
    }],
  }, { [new URL("rocm/10.2/overview.json", indexUrl).href]: { ...overview("10.2"), engines: [], history: [] } });
  expect(await screen.findByRole("region", { name: "llama.cpp nightly build history" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "b1352" })).not.toBeInTheDocument();
  expect(screen.queryByText("Downloads and reports")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "archive.zip" })).not.toBeInTheDocument();
  expect(screen.getByText("Qualification data unavailable")).toBeInTheDocument();
});


it("keeps the qualification timeline when a release has recorded builds", async () => {
  mount({
    ...index,
    versions: [{
      ...index.versions[0],
      release: {
        tag: "b11972",
        version: "10.1",
        url: "https://github.com/example/project/releases/tag/b11972",
        published_at: "2026-10-29T00:00:00Z",
        archives: [],
      },
    }],
  });
  const chart = await screen.findByRole("region", { name: "llama.cpp stable build history" });
  expect(within(chart).getByRole("link", { name: /linux-build/ })).toHaveAttribute("href", expect.stringContaining("focus=day"));
});

it("reports only measurements matched to the daily packages", async () => {
  const o = overview();
  const packageBuild = o.engines[0].latest_builds[0];
  const measurement = {
    source_id: "performance-source", engine: "llamacpp", channel: "stable", backend: "rocm",
    model: "Example model", scenario: "context-4k", measured_at: packageBuild.generated_at,
    rocm_version: "10.1", package_os: "linux", engine_version: packageBuild.tag,
    qualification_build_id: packageBuild.build_id, metrics: { tg_tps: 12 },
  };
  mount({ ...index, versions: [index.versions[0]] }, {
    [new URL("rocm/10.1/overview.json", indexUrl).href]: {
      ...o, performance: { status: "available", path: "rocm/10.1/performance.json", measurement_count: 3 },
    },
    [new URL("rocm/10.1/performance.json", indexUrl).href]: {
      schema_version: 2, systems: [], measurements: [measurement,
        { ...measurement, qualification_build_id: "another-build" },
        { ...measurement, metrics: {} }],
    },
  });
  const trigger = await screen.findByRole("link", { name: /Open package qualification.*linux-build/ });
  fireEvent.focus(trigger);
  const popup = await screen.findByRole("dialog");
  expect(await within(popup).findByText("1 benchmark measurement")).toBeInTheDocument();
  expect(within(popup).getAllByRole("link")).toHaveLength(1);
});

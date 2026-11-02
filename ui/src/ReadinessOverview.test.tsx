import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { ReadinessOverview } from "./ReadinessOverview";
import {
  fixtureFetch,
  indexUrl,
  overview,
  historyFixture,
  index,
  pointer,
  executionAttempt,
} from "./fixtures";
import type { Session } from "./data";

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
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest stable" });
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual(["ROCm 10.1 · Latest stable", "ROCm 10.2", "ROCm 10.10"]);
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.2" })).getByRole(
      "heading",
      { name: "llama.cpp" },
    ),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Pass: producer qualified")).toHaveLength(1);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("shows metricless non-passing executions without inventing qualification", async () => {
  const version = "10.2",
    o = overview(version);
  const attempts = (["passed", "failed", "partial", "unknown"] as const).map(
    (status) => executionAttempt(version, status),
  );
  const result = mount(
    {
      ...index,
      versions: [
        {
          rocm_version: version,
          overview: `rocm/${version}/overview.json`,
          build_count: 0,
        },
      ],
    },
    {
      [new URL(`rocm/${version}/overview.json`, indexUrl).href]: {
        ...o,
        engines: [{ ...o.engines[0], build_count: 0, latest_builds: [] }],
        history: [],
        performance: { status: "not_measured" },
        execution: {
          path: `rocm/${version}/executions.json`,
          attempt_count: 4,
          summaries: [],
        },
      },
      [new URL(`rocm/${version}/executions.json`, indexUrl).href]: {
        schema_version: 1,
        rocm_version: version,
        attempts,
        summaries: [],
      },
    },
  );
  await screen.findByRole("heading", { name: "ROCm 10.2" });
  for (const label of [
    "1 failed",
    "1 partial",
    "1 incomplete",
    "No qualification build records",
  ])
    expect(screen.getByText(label)).toBeInTheDocument();
  expect(result.container.querySelectorAll(".build-mark")).toHaveLength(0);
  expect(
    screen.queryByText("Inspect benchmark attempts"),
  ).not.toBeInTheDocument();
});

it("keeps other supplied tracks visible when one fails", async () => {
  mount(index, { [new URL("rocm/10.2/overview.json", indexUrl).href]: {} });
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest stable" });
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
    screen.queryByRole("heading", { name: /Latest stable/ }),
  ).not.toBeInTheDocument();
});

it("shows linked benchmark issues beside a passing qualification without changing its verdict", async () => {
  const o = overview();
  const attempts = (["failed", "partial", "unknown"] as const).map(
    (status) => ({
      ...executionAttempt("10.1", status),
      qualification_build_id: "linux-build",
    }),
  );
  const result = mount(
    { ...index, versions: [index.versions[0]] },
    {
      [new URL("rocm/10.1/overview.json", indexUrl).href]: {
        ...o,
        execution: {
          path: "rocm/10.1/executions.json",
          attempt_count: 3,
          summaries: [],
        },
      },
      [new URL("rocm/10.1/executions.json", indexUrl).href]: {
        schema_version: 1,
        rocm_version: "10.1",
        attempts,
        summaries: [],
      },
    },
  );
  const failure = await screen.findByRole("link", {
    name: /Bench fail: 1 recorded attempt/,
  });
  expect(failure).toHaveAttribute("href", attempts[0].source_url);
  expect(
    failure.parentElement?.querySelector(".build-mark.pass"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Bench partial: 1/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /Bench incomplete: 1/ }),
  ).toBeInTheDocument();
  expect(result.container.querySelectorAll(".build-mark.fail")).toHaveLength(0);
  expect(
    screen.queryByText("Inspect benchmark attempts"),
  ).not.toBeInTheDocument();
});

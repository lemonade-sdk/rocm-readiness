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

it("shows real versions together, latest observed stable first, then numeric ascending", async () => {
  const versions = ["10.10", "7.14", "10.2", "10.1"];
  const catalog = {
    ...index,
    versions: versions.map((v) => ({
      rocm_version: v,
      overview: `rocm/${v}/overview.json`,
      build_count: 1,
    })),
  };
  const fixtures: Record<string, unknown> = {};
  for (const v of versions) {
    const o = overview(v);
    const build = {
      ...o.engines[0].latest_builds[0],
      channel: v === "10.2" || v === "10.10" ? "nightly" : "stable",
      build_id: v,
      tag: v,
    };
    fixtures[new URL(`rocm/${v}/overview.json`, indexUrl).href] = {
      ...o,
      engines: [{ ...o.engines[0], build_count: 1, latest_builds: [build] }],
      history: [{ ...o.history[0], build_count: 1 }],
    };
    fixtures[new URL(`rocm/${v}/history/2026-10.json`, indexUrl).href] = {
      ...historyFixture(v),
      builds: [build],
    };
  }
  const session = {
    pointer,
    index: catalog,
    indexUrl,
    version: null,
    overview: null,
  } as Session;
  render(
    <MemoryRouter>
      <ReadinessOverview
        session={session}
        fetcher={fixtureFetch(fixtures)}
        onRetry={() => {}}
      />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest stable" });
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual([
    "ROCm 10.1 · Latest stable",
    "ROCm 7.14",
    "ROCm 10.2",
    "ROCm 10.10",
  ]);
  const track = screen.getByRole("region", { name: "ROCm 10.2" });
  expect(
    within(track).getByRole("heading", { name: "llama.cpp" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getAllByText("Pass: producer qualified")).toHaveLength(1);
});

it("shows execution-only versions and non-passing attempts without inventing qualification", async () => {
  const o = overview("7.13");
  const attempts = ["passed", "failed", "partial", "unknown"].map((status) =>
    executionAttempt("7.13", status as "passed"),
  );
  const fetcher = fixtureFetch({
    [new URL("rocm/7.13/overview.json", indexUrl).href]: {
      ...o,
      engines: [{ ...o.engines[0], build_count: 0, latest_builds: [] }],
      history: [],
      performance: { status: "not_measured" },
      execution: {
        path: "rocm/7.13/executions.json",
        attempt_count: 4,
        summaries: [],
      },
    },
    [new URL("rocm/7.13/executions.json", indexUrl).href]: {
      schema_version: 1,
      rocm_version: "7.13",
      attempts,
      summaries: [],
    },
  });
  const session = {
    pointer,
    index: {
      ...index,
      versions: [
        {
          rocm_version: "7.13",
          overview: "rocm/7.13/overview.json",
          build_count: 0,
        },
      ],
    },
    indexUrl,
    version: null,
    overview: null,
  } as Session;
  const result = render(
    <MemoryRouter>
      <ReadinessOverview
        session={session}
        fetcher={fetcher}
        onRetry={() => {}}
      />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "ROCm 7.13" });
  for (const label of [
    "Passed: 1",
    "Failed: 1",
    "Partial: 1",
    "Incomplete evidence: 1",
    "No qualification build records",
  ])
    expect(screen.getByText(label)).toBeInTheDocument();
  expect(result.container.querySelectorAll(".build-mark")).toHaveLength(0);
  expect(
    screen.queryByRole("heading", { name: /Latest stable/ }),
  ).not.toBeInTheDocument();
});

it("keeps other versions visible when one inventory fails", async () => {
  const fetcher = fixtureFetch({
    [new URL("rocm/10.0/overview.json", indexUrl).href]: {},
  });
  const session = {
    pointer,
    index,
    indexUrl,
    version: null,
    overview: null,
  } as Session;
  render(
    <MemoryRouter>
      <ReadinessOverview
        session={session}
        fetcher={fetcher}
        onRetry={() => {}}
      />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("heading", { name: "ROCm 10.1 · Latest stable" }),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.0" })).getByRole(
      "alert",
    ),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "ROCm 10.1" })).getByRole(
      "heading",
      { name: "llama.cpp" },
    ),
  ).toBeInTheDocument();
});

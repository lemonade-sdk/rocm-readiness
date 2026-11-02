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

it("shows real versions together, configured stable first and only newer recorded versions, numeric ascending", async () => {
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
      channel: "stable", // A stable engine channel does not declare ROCm GA.
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
  ).toEqual(["ROCm 10.1 · Latest stable", "ROCm 10.2", "ROCm 10.10"]);
  const track = screen.getByRole("region", { name: "ROCm 10.2" });
  expect(
    within(track).getByRole("heading", { name: "llama.cpp" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getAllByText("Pass: producer qualified")).toHaveLength(1);
});

it("shows execution-only versions and non-passing attempts without inventing qualification", async () => {
  const o = overview("10.2");
  const attempts = ["passed", "failed", "partial", "unknown"].map((status) =>
    executionAttempt("10.2", status as "passed"),
  );
  const fetcher = fixtureFetch({
    [new URL("rocm/10.2/overview.json", indexUrl).href]: {
      ...o,
      engines: [{ ...o.engines[0], build_count: 0, latest_builds: [] }],
      history: [],
      performance: { status: "not_measured" },
      execution: {
        path: "rocm/10.2/executions.json",
        attempt_count: 4,
        summaries: [],
      },
    },
    [new URL("rocm/10.2/executions.json", indexUrl).href]: {
      schema_version: 1,
      rocm_version: "10.2",
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
          rocm_version: "10.2",
          overview: "rocm/10.2/overview.json",
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
  await screen.findByRole("heading", { name: "ROCm 10.2" });
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
    [new URL("rocm/10.2/overview.json", indexUrl).href]: {},
  });
  const session = {
    pointer,
    index: {
      ...index,
      versions: [
        ...index.versions,
        {
          rocm_version: "10.2",
          overview: "rocm/10.2/overview.json",
          build_count: 1,
        },
      ],
    },
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
    within(screen.getByRole("region", { name: "ROCm 10.2" })).getByRole(
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

it("shows only the anchor with today's catalog and leaves historical detail data intact", async () => {
  const requested: string[] = [];
  const base = fixtureFetch();
  const fetcher = async (input: string | URL | Request) => {
    requested.push(String(input));
    return base(input);
  };
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
  await screen.findByRole("heading", { name: "ROCm 10.1 · Latest stable" });
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  expect(requested.some((url) => url.includes("/10.0/"))).toBe(false);
  expect(index.versions.some((entry) => entry.rocm_version === "10.0")).toBe(
    true,
  );
});

it("uses a changed configured anchor and omits a newer empty catalog entry", async () => {
  const versions = ["10.1", "10.2", "10.3"];
  const fixtures: Record<string, unknown> = {};
  for (const v of versions) {
    const o = overview(v);
    fixtures[new URL(`rocm/${v}/overview.json`, indexUrl).href] =
      v === "10.3"
        ? {
            ...o,
            engines: [],
            history: [],
            performance: { status: "not_measured" },
          }
        : o;
    fixtures[new URL(`rocm/${v}/history/2026-10.json`, indexUrl).href] =
      historyFixture(v);
  }
  const session = {
    pointer,
    index: {
      ...index,
      versions: versions.map((v) => ({
        rocm_version: v,
        overview: `rocm/${v}/overview.json`,
        build_count: v === "10.3" ? 0 : 1,
      })),
    },
    indexUrl,
    version: null,
    overview: null,
  } as Session;
  render(
    <MemoryRouter>
      <ReadinessOverview
        session={session}
        stableAnchor="10.2"
        fetcher={fixtureFetch(fixtures)}
        onRetry={() => {}}
      />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "ROCm 10.2 · Latest stable" });
  expect(
    screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
  ).toEqual(["ROCm 10.2 · Latest stable"]);
});

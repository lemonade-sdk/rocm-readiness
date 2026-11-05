import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { fixtureFetch, historyFixture, indexUrl, overview, pointer } from "./fixtures";

function mount(fetcher = fixtureFetch(), entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App fetcher={fetcher} />
    </MemoryRouter>,
  );
}
it("omits engine and channel sections without build records", async () => {
  mount();
  await screen.findByRole("region", { name: "ROCm 10.1" });
  for (const name of ["vLLM", "Whisper", "Stable Diffusion"])
    expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: /Nightly/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
});
it("shows separate linked UI and active data versions without the tagline", async () => {
  mount();
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  const ui = screen.getByRole("link", { name: /^UI [a-f0-9]{8}$/ });
  expect(ui.getAttribute("href")).toMatch(
    /^https:\/\/github.com\/lemonade-sdk\/rocm-readiness\/commit\/[a-f0-9]{40}$/,
  );
  expect(
    screen.getByRole("link", {
      name: `Data ${pointer.data_commit.slice(0, 8)}`,
    }),
  ).toHaveAttribute(
    "href",
    `https://github.com/lemonade-sdk/rocm-readiness/commit/${pointer.data_commit}`,
  );
  expect(screen.queryByText("Evidence you can trace.")).not.toBeInTheDocument();
});
it("keeps the UI version visible when initial data loading fails", async () => {
  mount(vi.fn().mockRejectedValue(new Error("Offline")));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("link", { name: /^UI [a-f0-9]{8}$/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /^Data / }),
  ).not.toBeInTheDocument();
});
it("updates only the data version after a successful dataset refresh", async () => {
  const original = fixtureFetch();
  let advance = false;
  const nextCommit = "b".repeat(40);
  const nextIndex = indexUrl.replace(pointer.data_commit, nextCommit);
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/history/") && !advance)
      throw new Error("History offline");
    if (advance && url.endsWith("/main/data/latest.json")) {
      return new Response(
        JSON.stringify({
          ...pointer,
          data_commit: nextCommit,
          index_url: nextIndex,
        }),
      );
    }
    return original(url.replace(nextCommit, pointer.data_commit));
  });
  mount(fetcher);
  await screen.findByRole("button", { name: "Retry history" });
  const uiHref = screen
    .getByRole("link", { name: /^UI [a-f0-9]{8}$/ })
    .getAttribute("href");
  advance = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
  expect(
    await screen.findByRole("link", { name: "Data bbbbbbbb" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /^UI [a-f0-9]{8}$/ }),
  ).toHaveAttribute("href", uiHref);
  expect(
    screen.queryByRole("link", { name: "Data aaaaaaaa" }),
  ).not.toBeInTheDocument();
});
it("ignores legacy overview platform filters and links a stable build to its review", async () => {
  const data = overview();
  data.engines[0].latest_builds.push({
    ...data.engines[0].latest_builds[0],
    build_id: "windows-build",
    os: "windows",
    tag: "b-windows",
  });
  mount(
    fixtureFetch({ [new URL("rocm/10.1/overview.json", indexUrl).href]: data }),
    "/?version=10.1&platform=linux",
  );
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  const engine = within(
    within(await screen.findByRole("region", { name: "ROCm 10.1" })).getByRole(
      "region",
      { name: "llama.cpp stable build history" },
    ),
  );
  expect(engine.getByRole("heading", { name: "Linux" })).toBeInTheDocument();
  expect(engine.getByRole("heading", { name: "Windows" })).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Platform" }),
  ).not.toBeInTheDocument();
  const link = within(
    screen.getByRole("region", { name: "ROCm 10.1" }),
  ).getByRole("link", { name: /b11972.*linux-build/ });
  const query = new URLSearchParams(link.getAttribute("href")!.split("?")[1]);
  expect(Object.fromEntries(query)).toMatchObject({
    view: "build-review",
    engine: "llamacpp",
    version: "10.1",
    platform: "linux",
    channel: "stable",
    build: "linux-build",
    source: "llamacpp-stable-qualification",
  });
  fireEvent.click(link);
  await screen.findByRole("heading", { name: "Build review" });
  expect(await screen.findByRole("link", { name: "Build evidence" })).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /Open build history-2 / }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "Engine builds" }));
  expect(await screen.findByRole("link", { name: "Nightly" })).toBeInTheDocument();
  expect(
    (await screen.findAllByRole("link", { name: /Open build history-2 / }))
      .length,
  ).toBeGreaterThan(0);
});
it("opens an empty version query as the catalog default", async () => {
  mount(fixtureFetch(), "/?version=");
  expect(
    await screen.findByRole("heading", { name: "ROCm Readiness" }),
  ).toBeInTheDocument();
});
it("shows a not-measured state for versions without measurements", async () => {
  mount(
    fixtureFetch({
      [new URL("rocm/10.1/overview.json", indexUrl).href]: {
        ...overview(),
        performance: { status: "not_measured" },
      },
    }),
  );
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  expect(
    screen.queryByText("Not measured", { exact: true }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Model measurements")).not.toBeInTheDocument();
});
it("loads the default version and shows real dataset scope", async () => {
  mount();
  expect(
    await screen.findByRole("heading", { name: "ROCm Readiness" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("ROCm version")).not.toBeInTheDocument();
  expect(
    (await screen.findAllByRole("heading", { name: "llama.cpp" }))[0],
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Pinned dataset" })).toHaveAttribute(
    "href",
    indexUrl,
  );
});
it("keeps the last good dataset visible after a refresh fails", async () => {
  const original = fixtureFetch();
  const fetcher = vi.fn((input: string | URL | Request) =>
    String(input).includes("/history/")
      ? Promise.reject(new Error("History unavailable"))
      : original(input),
  );
  mount(fetcher);
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  fetcher.mockRejectedValue(new Error("Network offline"));
  fireEvent.click(await screen.findByRole("button", { name: "Retry history" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((entry) => entry.textContent?.includes("Network offline")),
    ).toBe(true),
  );
  expect(
    screen.getByRole("heading", { name: "ROCm Readiness" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Keeping the last usable dataset/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Data aaaaaaaa" }),
  ).toBeInTheDocument();
});
it("omits the normal status strip and refresh button", async () => {
  mount();
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  expect(screen.queryByLabelText("Data status")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh data" }),
  ).not.toBeInTheDocument();
});
it("supports retry after initial fetch failure", async () => {
  const fetcher = vi
    .fn(fixtureFetch())
    .mockRejectedValueOnce(new Error("Offline"));
  mount(fetcher);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "ROCm Readiness" }),
  ).toBeInTheDocument();
});
it("shows an ingestion failure separately from the usable snapshot", async () => {
  mount(
    fixtureFetch({
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json":
        {
          ...pointer,
          sync: {
            ...pointer.sync,
            status: "failed",
            errors: [
              {
                source_id: "stable",
                record: "",
                field: "feed",
                reason: "Producer unavailable",
              },
            ],
          },
        },
    }),
  );
  await screen.findByRole("heading", { name: "ROCm Readiness" });
  expect(screen.getByText("Latest ingestion failed")).toBeInTheDocument();
  expect(screen.getByText(/Producer unavailable/)).toBeInTheDocument();
});
it("does not show the old version under a newly selected version while loading", async () => {
  let resolve!: (response: Response) => void;
  const original = fixtureFetch();
  const fetcher = vi.fn((input: string | URL | Request) =>
    String(input).includes("10.2/overview")
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : original(input),
  );
  mount(fetcher, "/?view=engine");
  await screen.findByRole("heading", { name: "llama.cpp builds" });
  fireEvent.change(screen.getByLabelText("ROCm version"), {
    target: { value: "10.2" },
  });
  expect(
    screen.queryByRole("heading", { name: "llama.cpp builds" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.change(screen.getByLabelText("ROCm version"), {
    target: { value: "10.1" },
  });
  await screen.findByRole("heading", { name: "llama.cpp builds" });
  await act(async () =>
    resolve(new Response(JSON.stringify(overview("10.2")))),
  );
  expect(
    screen.getByRole("heading", { name: "llama.cpp builds" }),
  ).toBeInTheDocument();
});
it("reopens shared engine scope and preserves filters in navigation", async () => {
  mount(
    fixtureFetch(),
    "/?version=10.2&view=engine&platform=linux&build=linux-build",
  );
  expect(
    await screen.findByRole("heading", { name: "llama.cpp builds" }),
  ).toBeInTheDocument();
  expect(await screen.findByLabelText("Platform")).toHaveValue("linux");
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "href",
    expect.stringContaining("platform=linux"),
  );
});

it("opens a nightly day stack and reviews an earlier failed build", async () => {
  const history = historyFixture();
  history.builds[0] = { ...history.builds[0], channel: "nightly", generated_at: "2026-10-29T15:00:00Z" };
  history.builds[2] = { ...history.builds[2], channel: "nightly", qualified: false, generated_at: "2026-10-29T12:00:00Z" };
  mount(fixtureFetch({
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: history,
  }), "/?version=10.1&view=engine&channel=nightly&day=2026-10-29&platform=linux");
  const stack = within(await screen.findByRole("group", { name: "2026-10-29 UTC, 2 builds" }));
  const builds = stack.getAllByRole("link");
  expect(builds[0]).toHaveAccessibleName(/linux-build.*Qualified/);
  expect(builds[1]).toHaveAccessibleName(/history-2.*Failed/);
  fireEvent.click(builds[1]);
  await screen.findByRole("heading", { name: "Build review" });
  fireEvent.click(await screen.findByRole("link", { name: "Performance evidence" }));
  await screen.findByRole("heading", { name: "Performance evidence" });
  expect(screen.queryByRole("heading", { name: "Build review" })).not.toBeInTheDocument();
});

it("shows only the exact build's measurements in performance evidence", async () => {
  const row = {
    source_id: "lemonade-performance", engine: "llamacpp", channel: "stable",
    backend: "rocm", engine_version: "b11972", model: "Matched model", scenario: "prompt",
    measured_at: "2026-10-30T00:00:00Z", rocm_version: "10.1", package_os: "linux",
    qualification_build_id: "linux-build", metrics: { tps_mean: 65 },
  };
  mount(fixtureFetch({
    [new URL("rocm/10.1/performance.json", indexUrl).href]: {
      schema_version: 2, systems: [],
      measurements: [row, { ...row, model: "Different package", engine_version: "other" }],
    },
  }), "/?view=build-performance&version=10.1&build=linux-build&platform=linux");
  expect(await screen.findByRole("heading", { name: "Matched model" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Different package" })).not.toBeInTheDocument();
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { fixtureFetch, indexUrl, overview, pointer } from "./fixtures";

function mount(fetcher = fixtureFetch(), entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App fetcher={fetcher} />
    </MemoryRouter>,
  );
}
it("shows separate linked UI and active data versions without the tagline", async () => {
  mount();
  await screen.findByRole("heading", { name: "ROCm readiness" });
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
  (await screen.findAllByRole("button", { name: "Retry history" }))[0];
  const uiHref = screen
    .getByRole("link", { name: /^UI [a-f0-9]{8}$/ })
    .getAttribute("href");
  advance = true;
  fireEvent.click(screen.getAllByRole("button", { name: "Retry history" })[0]);
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
it("opens every contributing daily build in a URL-scoped Page Two list", async () => {
  mount(fixtureFetch(), "/?version=10.1&platform=windows");
  const link = await screen.findByRole("link", {
    name: /10.1 stable linux: 2026-10-29/,
  });
  const query = new URLSearchParams(link.getAttribute("href")!.slice(1));
  expect(Object.fromEntries(query)).toMatchObject({
    view: "engine",
    engine: "llamacpp",
    version: "10.1",
    platform: "linux",
    channel: "stable",
    date: "2026-10-29",
  });
  expect(query.has("build")).toBe(false);
  fireEvent.click(link);
  await screen.findByText("Qualification reports for 2026-10-29 UTC");
  expect(
    (await screen.findAllByRole("link", { name: /Open build history-2 / }))
      .length,
  ).toBeGreaterThan(0);
  expect(
    screen.queryByRole("link", { name: /Open build history-1 / }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "Show all engine builds" }));
  expect(
    (await screen.findAllByRole("link", { name: /Open build history-1 / }))
      .length,
  ).toBeGreaterThan(0);
});
it("opens an empty version query as the catalog default", async () => {
  mount(fixtureFetch(), "/?version=");
  expect(
    await screen.findByRole("heading", { name: "ROCm readiness" }),
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
  await screen.findByRole("heading", { name: "ROCm readiness" });
  expect(
    screen.queryByText("Not measured", { exact: true }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Model measurements")).not.toBeInTheDocument();
});
it("loads the default version and shows real dataset scope", async () => {
  mount();
  expect(
    await screen.findByRole("heading", { name: "ROCm readiness" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("ROCm version")).not.toBeInTheDocument();
  await screen.findByRole("region", { name: "llama.cpp ROCm 10.1 stable" });
  expect(
    screen.getByRole("heading", { name: "llama.cpp" }),
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
  await screen.findByRole("heading", { name: "ROCm readiness" });
  fetcher.mockRejectedValue(new Error("Network offline"));
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "Retry history" }))[0],
  );
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((entry) => entry.textContent?.includes("Network offline")),
    ).toBe(true),
  );
  expect(
    screen.getByRole("heading", { name: "ROCm readiness" }),
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
  await screen.findByRole("heading", { name: "ROCm readiness" });
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
    await screen.findByRole("heading", { name: "ROCm readiness" }),
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
  await screen.findByRole("heading", { name: "ROCm readiness" });
  expect(screen.getByText("Latest ingestion failed")).toBeInTheDocument();
  expect(screen.getByText(/Producer unavailable/)).toBeInTheDocument();
});
it("does not show the old version under a newly selected version while loading", async () => {
  let resolve!: (response: Response) => void;
  const original = fixtureFetch();
  const fetcher = vi.fn((input: string | URL | Request) =>
    String(input).includes("10.0/overview")
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : original(input),
  );
  mount(fetcher, "/?view=engine");
  await screen.findByRole("heading", { name: "llama.cpp builds" });
  fireEvent.change(screen.getByLabelText("ROCm version"), {
    target: { value: "10.0" },
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
    resolve(new Response(JSON.stringify(overview("10.0")))),
  );
  expect(
    screen.getByRole("heading", { name: "llama.cpp builds" }),
  ).toBeInTheDocument();
});
it("reopens shared engine scope and preserves filters in navigation", async () => {
  mount(
    fixtureFetch(),
    "/?version=10.0&view=engine&platform=linux&build=linux-build",
  );
  expect(
    await screen.findByRole("heading", { name: "llama.cpp builds" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Platform")).toHaveValue("linux");
  expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "href",
    expect.stringContaining("platform=linux"),
  );
});
it("keeps healthy versions visible when the default overview fails", async () => {
  const original = fixtureFetch();
  const fetcher: typeof fetch = async (input) =>
    String(input) === new URL("rocm/10.1/overview.json", indexUrl).href
      ? new Response("{}", { status: 503 })
      : original(input);
  mount(fetcher);
  expect(
    await screen.findByRole("region", { name: "llama.cpp ROCm 10.0 stable" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent("ROCm 10.1");
});

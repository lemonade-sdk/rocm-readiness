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
it("opens an empty version query as the catalog default", async () => {
  mount(fixtureFetch(), "/?version=");
  expect(
    await screen.findByRole("heading", { name: "ROCm 10.1 readiness" }),
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
  await screen.findByRole("heading", { name: "ROCm 10.1 readiness" });
  expect(screen.getByText("Not measured", { exact: true })).toBeInTheDocument();
});
it("loads the default version and shows real dataset scope", async () => {
  mount();
  expect(
    await screen.findByRole("heading", { name: "ROCm 10.1 readiness" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("ROCm version")).toHaveValue("10.1");
  expect(screen.getByLabelText("Build qualification")).toHaveTextContent("26");
  expect(screen.getByRole("link", { name: "Pinned dataset" })).toHaveAttribute(
    "href",
    indexUrl,
  );
});
it("keeps the last good dataset visible after a refresh fails", async () => {
  const fetcher = vi.fn(fixtureFetch());
  mount(fetcher);
  await screen.findByRole("heading", { name: "ROCm 10.1 readiness" });
  fetcher.mockRejectedValue(new Error("Network offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network offline");
  expect(
    screen.getByRole("heading", { name: "ROCm 10.1 readiness" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Keeping the last usable dataset/),
  ).toBeInTheDocument();
});
it("supports retry after initial fetch failure", async () => {
  const fetcher = vi
    .fn(fixtureFetch())
    .mockRejectedValueOnce(new Error("Offline"));
  mount(fetcher);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "ROCm 10.1 readiness" }),
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
  await screen.findByRole("heading", { name: "ROCm 10.1 readiness" });
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
  mount(fetcher);
  await screen.findByRole("heading", { name: "ROCm 10.1 readiness" });
  fireEvent.change(screen.getByLabelText("ROCm version"), {
    target: { value: "10.0" },
  });
  expect(
    screen.queryByRole("heading", { name: "ROCm 10.1 readiness" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.change(screen.getByLabelText("ROCm version"), {
    target: { value: "10.1" },
  });
  await screen.findByRole("heading", { name: "ROCm 10.1 readiness" });
  await act(async () =>
    resolve(new Response(JSON.stringify(overview("10.0")))),
  );
  expect(
    screen.getByRole("heading", { name: "ROCm 10.1 readiness" }),
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

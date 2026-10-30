import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { App } from "../App";
import { fixtureFetch, indexUrl } from "../fixtures";
import { cellState, keepJob, loadUpstream } from "./data";
import { upstreamFetch, upstreamOverview } from "./fixtures";
import { loadSession } from "../data";

function mount(entry = "/?track=upstream", fetcher = upstreamFetch()) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App fetcher={fetcher} />
    </MemoryRouter>,
  );
}

it("shows one card per project with its computed upstream badge", async () => {
  mount();
  const card = (await screen.findByRole("heading", { name: "llama.cpp" })).closest("article")!;
  expect(within(card).getByText("upstream")).toHaveAttribute("title", expect.stringContaining("gfx1201"));
  const vllm = screen.getByRole("heading", { name: "vLLM" }).closest("article")!;
  expect(within(vllm).getByText("not upstreamed")).toBeInTheDocument();
  expect(within(vllm).getByText("No Radeon or Ryzen AI GPU is tested upstream.")).toBeInTheDocument();
  // Totals across projects come from the job records, not a stored number.
  expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Upstream health" })).toHaveAttribute("aria-current", "page");
});

it("lists forks with links without opening the project", async () => {
  mount();
  const card = (await screen.findByRole("heading", { name: "llama.cpp" })).closest("article")!;
  fireEvent.click(within(card).getByText("1 fork"));
  expect(within(card).getByRole("link", { name: "lemonade-sdk/llama.cpp" })).toHaveAttribute(
    "href",
    "https://github.com/lemonade-sdk/llama.cpp",
  );
  expect(screen.queryByRole("group", { name: "Filter" })).not.toBeInTheDocument();
});

it("opens a project page whose filter drives the headline numbers", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 1, name: "llama.cpp" });
  expect(screen.getByText("of 12 results on main passed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "vulkan" }));
  expect(await screen.findByText("of 8 results on main passed")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "vulkan" })).toHaveAttribute("aria-pressed", "true");
});

it("opens a day's runs with links to the job, the commit and the pull request", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 1, name: "llama.cpp" });
  const perDay = screen.getByRole("region", { name: "Per day" });
  fireEvent.click(within(perDay).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" }));
  const panel = await screen.findByRole("region", { name: "Runs on 2026-10-27" });
  await within(panel).findByText("10:00");
  expect(within(panel).getByRole("link", { name: "10:00" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/actions/runs/1/job/11",
  );
  expect(within(panel).getByRole("link", { name: "aaaaaaaa" })).toHaveAttribute(
    "href",
    `https://github.com/ggml-org/llama.cpp/commit/${"a".repeat(40)}`,
  );
  expect(within(panel).getByRole("link", { name: "#501 red" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/pull/501",
  );
  // Failures are listed first.
  const items = within(panel).getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("10:00");
});

it("shows the merge gate and the pull requests merged while red", async () => {
  mount("/?track=upstream&project=llamacpp");
  const gate = await screen.findByRole("region", { name: "Merge gate" });
  fireEvent.click(within(gate).getByRole("button", { name: "1" }));
  expect(within(gate).getByRole("link", { name: "#501" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/pull/501",
  );
  expect(within(gate).getByRole("link", { name: "failing check" })).toBeInTheDocument();
});

it("flags a platform that ships without an AMD hardware test", async () => {
  mount("/?track=upstream&project=llamacpp");
  const platforms = await screen.findByRole("region", { name: "Platforms" });
  const windows = within(platforms).getByRole("row", { name: /Windows/ });
  expect(windows).toHaveTextContent("✗");
});

it("explains a dataset published before the upstream view existed", async () => {
  mount("/?track=upstream", fixtureFetch());
  expect(await screen.findByText("No upstream health in this dataset")).toBeInTheDocument();
});

it("rejects upstream paths that escape the pinned dataset", async () => {
  const fetcher = upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: {
      ...upstreamOverview,
      projects: [{ ...upstreamOverview.projects[0], files: [{ month: "2026-10", path: "../x.json", run_count: 0 }] }],
    },
  });
  const session = await loadSession(undefined, fetcher);
  await expect(loadUpstream(session, fetcher)).rejects.toThrow("Invalid dataset path");
});

it("colours a day by its pass rate and keeps stalls distinct", () => {
  const c = (passed: number, failed: number, stalled = 0) => ({
    passed, failed, other: 0, stalled, skipped: 0, running: 0, slow: 0,
  });
  expect(cellState(c(19, 1))).toBe("good");
  expect(cellState(c(9, 1))).toBe("warn");
  expect(cellState(c(1, 1))).toBe("bad");
  expect(cellState(c(0, 0, 3))).toBe("stall");
  expect(cellState(undefined)).toBe("idle");
  const job = upstreamOverview.projects[0].jobs[1] as never;
  expect(keepJob("vulkan")(job)).toBe(true);
  expect(keepJob("gfx1151")(job)).toBe(false);
});

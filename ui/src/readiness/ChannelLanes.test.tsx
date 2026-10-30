import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { App } from "../App";
import { index, indexUrl, overview } from "../fixtures";
import { upstreamFetch, upstreamOverview } from "../upstream/fixtures";
import { ChannelLanes } from "./ChannelLanes";

const sources = [
  {
    id: "llamacpp-stable-qualification",
    engine: "llamacpp",
    channel: "stable",
    adapter: "qualification-v1",
    status: "fresh",
    repository: "lemonade-sdk/llama.cpp",
  },
  {
    id: "llamacpp-nightly-qualification",
    engine: "llamacpp",
    channel: "nightly",
    adapter: "qualification-v1",
    status: "awaiting_data",
    repository: "lemonade-sdk/llamacpp-rocm",
  },
  {
    id: "lemonade-performance",
    engine: "llamacpp",
    channel: "from-fork",
    adapter: "lemonade-leaderboard-v1",
    status: "fresh",
    repository: "lemonade-sdk/lemonade",
  },
];

it("shows stable and nightly lanes and forks no feed reads yet", () => {
  render(
    <ChannelLanes
      sources={sources}
      engines={overview().engines as never}
      version="10.1"
      upstream={
        {
          ...upstreamOverview,
          projects: [
            {
              ...upstreamOverview.projects[0],
              forks: [
                {
                  repository: "lemonade-sdk/llama.cpp",
                  role: "stable builds",
                  channel: "stable",
                },
                {
                  repository: "AMD-Ecosystem/llama.cpp",
                  role: "gfx11 nightly builds",
                  channel: "nightly",
                },
              ],
            },
          ],
        } as never
      }
    />,
  );
  const table = screen.getByRole("table", { name: "llama.cpp" });
  const stable = within(table).getByRole("row", {
    name: /^stable lemonade-sdk\/llama.cpp fresh/,
  });
  expect(stable).toHaveTextContent("b11972 (linux)");
  expect(
    within(table).getByRole("row", {
      name: /nightly lemonade-sdk\/llamacpp-rocm awaiting data/,
    }),
  ).toHaveTextContent("not published yet");
  // A fork that is already read by a feed is not listed twice; the other is.
  expect(
    within(table).getAllByRole("link", { name: "lemonade-sdk/llama.cpp" }),
  ).toHaveLength(1);
  expect(
    within(table).getByRole("row", {
      name: /AMD-Ecosystem\/llama.cpp not collected/,
    }),
  ).toBeInTheDocument();
  // Performance feeds are not qualification lanes.
  expect(
    within(table).queryByText("lemonade-sdk/lemonade"),
  ).not.toBeInTheDocument();
});

it("renders the lanes under the readiness overview", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App
        fetcher={upstreamFetch({
          [indexUrl]: {
            ...index,
            sources,
            upstream: {
              schema_version: 1,
              overview: "upstream/overview.json",
              project_count: 2,
              status: "fresh",
            },
          },
        })}
      />
    </MemoryRouter>,
  );
  expect(
    await screen.findByRole("region", { name: "Channels and forks" }),
  ).toBeInTheDocument();
});

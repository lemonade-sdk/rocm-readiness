import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { App } from "../App";
import { fixtureFetch, indexUrl } from "../fixtures";
import { cellState, keepJob, loadUpstream, type UpstreamOverview } from "./data";
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
  const card = (
    await screen.findByRole("heading", { name: "llama.cpp" })
  ).closest("article")!;
  expect(within(card).getByText("upstream")).toHaveAttribute(
    "title",
    expect.stringContaining("gfx1201"),
  );
  const vllm = screen
    .getByRole("heading", { name: "vLLM" })
    .closest("article")!;
  expect(within(vllm).getByText("Configured coverage unknown")).toBeInTheDocument();
  expect(
    within(vllm).getByText("No conclusion about upstream support can be drawn from the configured coverage."),
  ).toBeInTheDocument();
  // Totals across projects come from the job records, not a stored number.
  expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "Upstream health" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

it("lists forks with links without opening the project", async () => {
  mount();
  const card = (
    await screen.findByRole("heading", { name: "llama.cpp" })
  ).closest("article")!;
  fireEvent.click(within(card).getByText("1 fork"));
  expect(
    within(card).getByRole("link", { name: "lemonade-sdk/llama.cpp" }),
  ).toHaveAttribute("href", "https://github.com/lemonade-sdk/llama.cpp");
  expect(
    screen.queryByRole("group", { name: "Filter" }),
  ).not.toBeInTheDocument();
});

it("opens a project page whose filter drives the headline numbers", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 1, name: "llama.cpp" });
  expect(screen.getByText("of 12 results on main passed")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "vulkan" }));
  expect(
    await screen.findByText("of 8 results on main passed"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "vulkan" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("opens a day's runs with links to the job, the commit and the pull request", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 1, name: "llama.cpp" });
  const perDay = screen.getByRole("region", { name: "Per day" });
  fireEvent.click(
    within(perDay).getByRole("button", {
      name: "2026-10-27: 3 passed, 1 failed of 4 runs",
    }),
  );
  const panel = await screen.findByRole("region", {
    name: "Runs on 2026-10-27",
  });
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
  expect(
    within(gate).getByRole("link", { name: "failing check" }),
  ).toBeInTheDocument();
});

it("flags a platform that ships without an AMD hardware test", async () => {
  mount("/?track=upstream&project=llamacpp");
  const platforms = await screen.findByRole("region", { name: "Platforms" });
  const windows = within(platforms).getByRole("row", { name: /Windows/ });
  expect(windows).toHaveTextContent("✗");
});

it("explains a dataset published before the upstream view existed", async () => {
  mount("/?track=upstream", fixtureFetch());
  expect(
    await screen.findByText("No upstream health in this dataset"),
  ).toBeInTheDocument();
});

it("rejects upstream paths that escape the pinned dataset", async () => {
  const fetcher = upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: {
      ...upstreamOverview,
      projects: [
        {
          ...upstreamOverview.projects[0],
          files: [{ month: "2026-10", path: "../x.json", run_count: 0 }],
        },
      ],
    },
  });
  const session = await loadSession(undefined, fetcher);
  await expect(loadUpstream(session, fetcher)).rejects.toThrow(
    "Invalid dataset path",
  );
});

it("colours a day by its pass rate and keeps stalls distinct", () => {
  const c = (passed: number, failed: number, stalled = 0) => ({
    passed,
    failed,
    other: 0,
    stalled,
    skipped: 0,
    running: 0,
    slow: 0,
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

it("opens upstream without requesting a readiness overview, even for an unknown version", async () => {
  const base = upstreamFetch();
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    requested.push(String(input));
    if (String(input).includes('/rocm/')) return new Response('', { status: 404 });
    return base(input);
  };
  mount('/?track=upstream&version=unknown', fetcher);
  expect(await screen.findByRole('heading', { name: 'llama.cpp' })).toBeInTheDocument();
  expect(requested.some((url) => url.includes('/rocm/'))).toBe(false);
});

it('does not draw pass bars for failed or running-only days', async () => {
  const project = upstreamOverview.projects[0];
  const empty = { passed: 0, failed: 0, other: 0, stalled: 0, skipped: 0, running: 0, slow: 0 };
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, jobs: [{ ...project.jobs[0], daily: { '2026-10-27': { ...empty, failed: 1 }, '2026-10-28': { ...empty, running: 1 } } }] }]
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  const region = await screen.findByRole('region', { name: 'Per day' });
  expect(within(region).getByRole('button', { name: /2026-10-27:/ }).querySelector('.up-pass')).toBeNull();
  expect(within(region).getByRole('button', { name: /2026-10-28:/ }).querySelector('.up-pass')).toBeNull();
});

it('shows collection errors and labels configured distribution without shipment checks', async () => {
  const project = upstreamOverview.projects[0];
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, coverage: { complete: false, error: 'API unavailable' } }]
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  expect(await screen.findByText(/API unavailable/)).toBeInTheDocument();
  const platforms = screen.getByRole('region', { name: 'Platforms' });
  expect(within(platforms).getByText('Configured distribution')).toBeInTheDocument();
  expect(within(platforms).getByText('win-rocm archive')).toBeInTheDocument();
});

it('keeps the pinned index when navigating between dashboards', async () => {
  const base = upstreamFetch();
  let pointers = 0;
  const fetcher = async (input: string | URL | Request) => {
    if (String(input).endsWith('/main/data/latest.json')) pointers++;
    return base(input);
  };
  mount('/', fetcher);
  await screen.findByRole('heading', { name: 'ROCm 10.1 readiness' });
  fireEvent.click(screen.getByRole('link', { name: 'Upstream health' }));
  await screen.findByRole('heading', { name: 'llama.cpp' });
  fireEvent.click(screen.getByRole('link', { name: 'ROCm readiness' }));
  await screen.findByRole('heading', { name: 'ROCm 10.1 readiness' });
  expect(pointers).toBe(1);
});

it('opens upstream when the default readiness overview returns 404', async () => {
  const base = upstreamFetch();
  const fetcher = async (input: string | URL | Request) =>
    String(input).includes('/rocm/') ? new Response('', { status: 404 }) : base(input);
  mount('/?track=upstream', fetcher);
  expect(await screen.findByRole('heading', { name: 'llama.cpp' })).toBeInTheDocument();
});

it('does not fetch upstream on a readiness route', async () => {
  const base = upstreamFetch();
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    requested.push(String(input));
    return base(input);
  };
  mount('/', fetcher);
  await screen.findByRole('heading', { name: 'ROCm 10.1 readiness' });
  expect(requested.some((url) => url.includes('/upstream/'))).toBe(false);
});

it('opens upstream on the same pinned index after readiness overview fails', async () => {
  const base = upstreamFetch();
  let pointers = 0;
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/main/data/latest.json')) pointers++;
    if (url.includes('/rocm/')) return new Response('', { status: 404 });
    return base(input);
  };
  mount('/', fetcher);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('link', { name: 'Upstream health' }));
  expect(await screen.findByRole('heading', { name: 'llama.cpp' })).toBeInTheDocument();
  expect(pointers).toBe(1);
});

it('does not retry a failed refresh implicitly when switching dashboards', async () => {
  const base = upstreamFetch();
  let pointers = 0;
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/main/data/latest.json') && ++pointers > 1) throw new Error('Offline');
    if (url.includes('/history/')) throw new Error('History offline');
    return base(input);
  };
  mount('/', fetcher);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry history' }));
  await screen.findByText('Offline');
  fireEvent.click(screen.getByRole('link', { name: 'Upstream health' }));
  await screen.findByRole('heading', { name: 'llama.cpp' });
  expect(pointers).toBe(2);
});

function incompleteFetch(error?: string) {
  const project = upstreamOverview.projects[0];
  const jobs = project.jobs.map((job) => ({
    ...job, daily: {}, decided: 0, passed: 0, started: 0, stalled: 0,
    skipped: 0, last_ran: null, quiet_days: [], failed_steps: {}, gate: null,
  }));
  return upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, jobs, files: [], findings: [],
      kpis: { ...project.kpis, decided: 0, passed: 0, not_running: 2, merged_red: 0 },
      coverage: { complete: false, ...(error ? { error } : {}) } }],
  }});
}

it('shows unknown rather than unobserved not-running counts in incomplete project cards and totals', async () => {
  mount('/?track=upstream', incompleteFetch());
  const card = (await screen.findByRole('heading', { name: 'llama.cpp' })).closest('article')!;
  expect(within(card).getByText('tests not running').parentElement).toHaveTextContent('Unknown');
  const total = screen.getByRole('region', { name: 'Upstream projects' });
  expect(within(total).getAllByText('tests not running')[0].parentElement).toHaveTextContent('Unknown');
});

it('does not describe uncollected runs as absent in incomplete project details', async () => {
  mount('/?track=upstream&project=llamacpp', incompleteFetch());
  await screen.findByRole('heading', { level: 1, name: 'llama.cpp' });
  expect(screen.getByText('tests not running').parentElement).toHaveTextContent('Unknown');
  expect(screen.getByText(/No collected runs/)).toBeInTheDocument();
  expect(screen.getByText(/No collected failing-step details/)).toBeInTheDocument();
  const perDay = screen.getByRole('region', { name: 'Per day' });
  fireEvent.click(within(perDay).getByRole('button', { name: /2026-10-27: no collected evidence/ }));
  expect(await screen.findByText('No collected evidence for this day.')).toBeInTheDocument();
  fireEvent.click(screen.getByText('By job'));
  expect(screen.queryByText(/never ran/)).not.toBeInTheDocument();
});

it('shows a plain collection failure with optional diagnostics', async () => {
  mount('/?track=upstream&project=llamacpp', incompleteFetch('OSError: https://example.com/private'));
  expect(await screen.findByText('Collection failed. The displayed results may be incomplete.')).toBeInTheDocument();
  const details = screen.getByText('Technical details').closest('details')!;
  expect(details).not.toHaveAttribute('open');
  expect(within(details).getByText('OSError: https://example.com/private')).toBeInTheDocument();
});

it('retains observed failures and stalls when collection is incomplete', async () => {
  const project = upstreamOverview.projects[0];
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, coverage: { complete: false } }],
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  const perDay = await screen.findByRole('region', { name: 'Per day' });
  expect(within(perDay).getByRole('button', { name: /2026-10-27: 3 passed, 1 failed/ }).querySelector('.up-fail')).toBeInTheDocument();
  expect(within(perDay).getByRole('button', { name: /2026-10-29: 2 requested, none ran/ }).querySelector('.up-stall')).toBeInTheDocument();
  expect(screen.getByText('Test')).toBeInTheDocument();
});

it('does not imply there were no failures when failing-step details are absent', async () => {
  const project = upstreamOverview.projects[0];
  const jobs = project.jobs.map((job) => ({ ...job, failed_steps: {} }));
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, jobs }],
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  const perDay = await screen.findByRole('region', { name: 'Per day' });
  expect(within(perDay).getByRole('button', { name: /2026-10-27: 3 passed, 1 failed/ }).querySelector('.up-fail')).toBeInTheDocument();
  expect(screen.getByText('No collected failing-step details.')).toBeInTheDocument();
});

it("distinguishes missing checks from unknown historical results and escaped failures", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  const gate = data.projects[0].jobs[0].gate!;
  gate.no_result = 1;
  gate.escaped = [
    { ...gate.red[0], number: 502, verdict: "no_result" },
    { ...gate.red[0], number: 503, verdict: "not_triggered" },
  ];
  mount("/?track=upstream&project=llamacpp", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const region = await screen.findByRole("region", { name: "Merge gate" });
  expect(within(region).getByText("No run")).toHaveAttribute("title", "never ran on the pull request");
  expect(within(region).getByText("Unknown")).toHaveAttribute("title", "historical pull request result is unknown");
  const row = within(region).getByRole("row", { name: /gpu-rocm/ });
  expect(within(row).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["3", "1", "1", "1", "1", "2"]);
  fireEvent.click(within(row).getByRole("button", { name: "2" }));
  expect(within(region).getByText("historical result unknown")).toBeInTheDocument();
  expect(within(region).getByText("never ran on the pull request")).toBeInTheDocument();
});

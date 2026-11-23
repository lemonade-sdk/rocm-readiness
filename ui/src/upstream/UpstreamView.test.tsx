import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { fixtureFetch, indexUrl } from "../fixtures";
import { cellState, keepJob, loadUpstream, type UpstreamOverview } from "./data";
import { upstreamFetch, upstreamOverview } from "./fixtures";
import { loadSession } from "../data";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("expands phone daily evidence inside its own dated row", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  mount("/?track=upstream&view=ci&project=llamacpp");
  const row = await screen.findByRole("article", { name: "CI activity on 2026-10-27 UTC" });
  const toggle = within(row).getByRole("button", { name: /^2026-10-27:/ });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await within(row).findByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
  expect(within(row).getByRole("region", { name: "Runs on 2026-10-27" }).closest("table")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(row).queryByRole("region", { name: "Runs on 2026-10-27" })).not.toBeInTheDocument();
});

it("restores a selected phone job and its dated evidence from the URL", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  mount("/?track=upstream&view=ci&project=llamacpp&day=2026-10-27&activity=job:gpu-rocm");
  const table = await screen.findByRole("table", { name: "gpu-rocm daily outcomes" });
  expect(table.closest("details")).toHaveAttribute("open");
  expect(within(table).getAllByRole("rowheader")).toHaveLength(14);
  expect(await screen.findByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeVisible();
});

function mount(entry = "/?track=upstream", fetcher = upstreamFetch()) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <App fetcher={fetcher} />
    </MemoryRouter>,
  );
}

it("uses the shared label/value summary for a healthy upstream observation", async () => {
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  data.projects[0].jobs[0].daily["2026-10-27"].passed = 2;
  data.projects[0].jobs[0].daily["2026-10-27"].failed = 0;
  mount("/?track=upstream", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
  const mark = within(calendar).getByLabelText("2026-10-27: 2 passed, 0 failed of 2 runs");
  fireEvent.mouseEnter(mark);
  const tooltip = await screen.findByRole("dialog");
  expect(within(tooltip).getByText("2026-10-27", { exact: true })).toBeVisible();
  expect(tooltip.querySelector(".up-run-summary")?.textContent).toBe("Passed2Failed0Total runs2");
  expect(tooltip.querySelector(".cell-explanation")).toBeNull();
  expect(within(tooltip).queryByText(/reason is not established|Snapshot collected|notification|Collected CI outcomes/)).not.toBeInTheDocument();
  expect(mark).toHaveAttribute("href", expect.stringContaining("day=2026-10-27"));
  expect(within(tooltip).getByText("Activity", { selector: "dt" })).toBeVisible();
  expect(within(tooltip).getByRole("link", { name: "View CI activity" })).toHaveAttribute("href", expect.stringContaining("activity=cat%3Atests"));
  expect(within(tooltip).queryByRole("button", { name: "Close popup" })).not.toBeInTheDocument();
});

it("keeps an idle overview day concise with an aligned activity link", async () => {
  mount();
  const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
  fireEvent.focus(within(calendar).getByRole("button", { name: "2026-10-26: No observation" }));
  const popup = await screen.findByRole("dialog");
  expect(popup.querySelector(".up-run-summary")).toBeNull();
  expect(within(popup).getByText("Activity", { selector: "dt" })).toBeVisible();
  const navigation = within(popup).getByRole("link", { name: "View CI activity" });
  expect(navigation.closest("dd")).not.toBeNull();
  expect(navigation).toHaveAttribute("href", expect.stringContaining("day=2026-10-26"));
  expect(within(popup).queryByRole("button", { name: "Close popup" })).not.toBeInTheDocument();
});

it("opens a healthy phone day as inline evidence with the same activity link and dismissal", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  data.projects[0].jobs[0].daily["2026-10-27"].failed = 0;
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
  const trigger = within(calendar).getByRole("button", { name: "2026-10-27: 3 passed, 0 failed of 3 runs" });
  fireEvent.click(trigger);
  const evidence = screen.getByRole("region", { name: "2026-10-27: 3 passed, 0 failed of 3 runs" });
  expect(within(evidence).getByText("Activity", { selector: "dt" })).toBeVisible();
  expect(within(evidence).getByRole("link", { name: "View CI activity" })).toHaveAttribute("href", expect.stringContaining("day=2026-10-27"));
  fireEvent.keyDown(evidence, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "2026-10-27: 3 passed, 0 failed of 3 runs" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("shows structured outcome counts when no failure assessment is available", async () => {
  mount();
  const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
  fireEvent.focus(within(calendar).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" }));
  const popup = await screen.findByRole("dialog");
  const summary = popup.querySelector(".up-run-summary")!;
  expect(summary).not.toBeNull();
  expect(within(summary as HTMLElement).getAllByRole("term").map(item => item.textContent)).toEqual(["Passed", "Failed", "Total runs"]);
  expect(within(summary as HTMLElement).getAllByRole("definition").map(item => item.textContent)).toEqual(["3", "1", "4"]);
  expect(within(popup).queryByText("2026-10-27: 3 passed, 1 failed of 4 runs", { exact: true })).not.toBeInTheDocument();
  expect(within(popup).getByRole("link", { name: "View CI activity" })).toHaveAttribute("href", expect.stringContaining("day=2026-10-27"));
  expect(within(popup).getByText("Activity", { selector: "dt" })).toBeVisible();
  expect(within(popup).queryByRole("button", { name: "Close popup" })).not.toBeInTheDocument();
});

it("retains non-verdict outcomes in the overview summary", async () => {
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  data.projects[0].jobs[0].daily["2026-10-27"] = {
    passed: 3, failed: 1, running: 2, other: 1, skipped: 4, stalled: 5, slow: 0,
  };
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  const calendar = await screen.findByRole("region", { name: "llama.cpp activity calendar" });
  fireEvent.focus(within(calendar).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 7 runs, 2 running, 1 other results" }));
  const popup = await screen.findByRole("dialog");
  const summary = popup.querySelector(".up-run-summary")!;
  expect(summary).not.toBeNull();
  expect(within(summary as HTMLElement).getAllByRole("term").map(item => item.textContent)).toEqual(["Passed", "Failed", "Total runs", "Running", "Other results", "Skipped", "Requested, no runs"]);
  expect(within(summary as HTMLElement).getAllByRole("definition").map(item => item.textContent)).toEqual(["3", "1", "7", "2", "1", "4", "5"]);
});

it("shows one card per project with its computed upstream badge", async () => {
  mount();
  const card = (
    await screen.findByRole("heading", { name: "llama.cpp" })
  ).closest("article")!;
  fireEvent.focus(within(card).getByRole("button", { name: /^upstream$/ }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("gfx1201");
  expect(card.querySelector(".up-status-labels [title]")).toBeNull();
  fireEvent.keyDown(within(card).getByRole("button", { name: /^upstream$/ }), { key: "Escape" });
  expect(screen.queryByRole("heading", { name: "vLLM" })).not.toBeInTheDocument();
  // Overview keeps the calendar prominent; metrics live in CI Activity.
  expect(screen.queryByRole("group", { name: "CI metrics" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Upstream health" })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

it("lists forks with links without opening the project", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  await screen.findByRole("heading", { name: "llama.cpp" });
  const card = screen.getByRole("region", { name: "llama.cpp upstream health" });
  expect(
    within(card).getByRole("link", { name: "lemonade-sdk/llama.cpp" }),
  ).toHaveAttribute("href", "https://github.com/lemonade-sdk/llama.cpp");
  expect(screen.getByRole("group", { name: "Project" })).toBeInTheDocument();
});

it("opens a project page whose filter drives the headline numbers", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 2, name: "llama.cpp" });
  expect(screen.getByText("of 12")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "rocm" }));
  expect(
    await screen.findByText("of 8"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "vulkan" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

it("opens a day's runs with links to the job, the commit and the pull request", async () => {
  mount("/?track=upstream&project=llamacpp");
  await screen.findByRole("heading", { level: 2, name: "llama.cpp" });
  const perDay = screen.getByRole("region", { name: "Daily activity" });
  fireEvent.click(
    within(perDay).getByRole("button", {
      name: "2026-10-27: 3 passed, 1 failed of 4 runs",
    }),
  );
  const panel = await screen.findByRole("region", {
    name: "Runs on 2026-10-27",
  });
  await within(panel).findByText("10:00 UTC");
  expect(within(panel).getByRole("link", { name: "Job log at 10:00 UTC · failed" })).toHaveAttribute(
    "href",
    "https://github.com/ggml-org/llama.cpp/actions/runs/1/job/11",
  );
  expect(within(panel).getByRole("link", { name: "Commit aaaaaaaa" })).toHaveAttribute(
    "href",
    `https://github.com/ggml-org/llama.cpp/commit/${"a".repeat(40)}`,
  );
  expect(within(panel).getByRole("link", { name: "#501" })).toHaveAttribute(
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
  expect(windows.querySelector('svg[data-outcome="unreported"]')).toHaveAttribute("aria-hidden", "true");
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

it('distinguishes failed days from days without a decided result', async () => {
  const project = upstreamOverview.projects[0];
  const empty = { passed: 0, failed: 0, other: 0, stalled: 0, skipped: 0, running: 0, slow: 0 };
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, jobs: [{ ...project.jobs[0], daily: { '2026-10-27': { ...empty, failed: 1 }, '2026-10-28': { ...empty, running: 1 } } }] }]
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  const region = await screen.findByRole('region', { name: 'Daily activity' });
  expect(within(region).getByRole('button', { name: /2026-10-27:/ }).closest('td')).toHaveAttribute('data-outcome', 'fail');
  expect(within(region).getByRole('button', { name: /2026-10-28:/ }).closest('td')).toHaveAttribute('data-outcome', 'pending');
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
  await screen.findByRole('heading', { name: 'ROCm Readiness' });
  fireEvent.click(screen.getByRole('link', { name: 'Upstream health' }));
  await screen.findByRole('heading', { name: 'llama.cpp' });
  fireEvent.click(screen.getByRole('link', { name: 'ROCm readiness' }));
  await screen.findByRole('heading', { name: 'ROCm Readiness' });
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
  await screen.findByRole('heading', { name: 'ROCm Readiness' });
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
  expect(await screen.findAllByRole('alert')).toHaveLength(2);
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
      activity_assessment: { message: "Activity assessment unavailable — collection incomplete.", metrics: [] },
      coverage: { complete: false, ...(error ? { error } : {}) } }],
  }});
}

it('omits aggregate metrics from incomplete overview projects', async () => {
  mount('/?track=upstream', incompleteFetch());
  const card = (await screen.findByRole('heading', { name: 'llama.cpp' })).closest('article')!;
  expect(within(card).queryByRole('group', { name: 'CI metrics' })).not.toBeInTheDocument();
  const total = screen.getByRole('region', { name: 'Upstream projects' });
  expect(within(total).queryByText('tests not running')).not.toBeInTheDocument();
});

it('does not describe uncollected runs as absent in incomplete project details', async () => {
  mount('/?track=upstream&project=llamacpp', incompleteFetch());
  await screen.findByRole('heading', { level: 2, name: 'llama.cpp' });
  expect(screen.queryByText('Activity assessment unavailable — collection incomplete.')).not.toBeInTheDocument();
  for (const label of ['No runs observed', 'Requests not started']) {
    expect(screen.getByText(label).parentElement).toHaveTextContent('0');
  }
  expect(screen.getByText(/No collected runs/)).toBeInTheDocument();
  expect(screen.getByText(/No collected failing-step details/)).toBeInTheDocument();
  const perDay = screen.getByRole('region', { name: 'Daily activity' });
  expect(within(perDay).queryByRole('button', { name: /2026-10-27: No observation/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Collection incomplete.*oldest days may be missing/)).toBeVisible();
  expect(screen.getByRole('table', { name: 'CI jobs' })).toBeInTheDocument();
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
  const perDay = await screen.findByRole('region', { name: 'Daily activity' });
  expect(within(perDay).getByRole('button', { name: /2026-10-27: 3 passed, 1 failed/ }).closest('td')).toHaveAttribute('data-outcome', 'fail');
  expect(within(perDay).getByRole('button', { name: /2026-10-29: 2 requested, none ran/ }).querySelector('.up-activity-stall')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument();
});

it('does not imply there were no failures when failing-step details are absent', async () => {
  const project = upstreamOverview.projects[0];
  const jobs = project.jobs.map((job) => ({ ...job, failed_steps: {} }));
  const fetcher = upstreamFetch({ [new URL('upstream/overview.json', indexUrl).href]: {
    ...upstreamOverview, projects: [{ ...project, jobs }],
  }});
  mount('/?track=upstream&project=llamacpp', fetcher);
  const perDay = await screen.findByRole('region', { name: 'Daily activity' });
  expect(within(perDay).getByRole('button', { name: /2026-10-27: 3 passed, 1 failed/ }).closest('td')).toHaveAttribute('data-outcome', 'fail');
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

it("separates source links from project navigation and provides a return path", async () => {
  mount();
  const heading = await screen.findByRole("heading", { name: "llama.cpp" });
  const card = heading.closest("article")!;
  expect(within(card).queryByRole("link", { name: /Repository:/ })).not.toBeInTheDocument();
  expect(within(card).queryByText(/fork/)).not.toBeInTheDocument();
  fireEvent.click(card);
  expect(screen.queryByRole("group", { name: "Project" })).not.toBeInTheDocument();
  expect(within(heading).getByRole("link", { name: "llama.cpp" })).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Daily CI activity" })).toBeInTheDocument();
  fireEvent.click(within(heading).getByRole("link", { name: "llama.cpp" }));
  expect(await screen.findByRole("link", { name: "Repository: ggml-org/llama.cpp" })).toHaveAttribute("href", "https://github.com/ggml-org/llama.cpp");
  await screen.findByRole("heading", { level: 2, name: "llama.cpp" });
  expect(screen.getByRole("table", { name: "Daily CI activity" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Project navigation" })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("list", { name: "Upstream health views" })).getByRole("link", { name: "Overview" }));
  await screen.findByRole("region", { name: "Upstream projects" });
  expect(screen.queryByRole("group", { name: "Project" })).not.toBeInTheDocument();
});

it("uses workspace sub-pages and retains project scope between overview and activity", async () => {
  mount("/?track=upstream");
  await screen.findByRole("heading", { name: "llama.cpp" });
  const views = screen.getByRole("list", { name: "Upstream health views" });
  expect(within(views).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  expect(screen.queryByRole("link", { name: /View .* details/ })).not.toBeInTheDocument();
  fireEvent.click(within(views).getByRole("link", { name: "CI Activity" }));
  await screen.findByRole("group", { name: "Project" });
  expect(screen.getByRole("heading", { level: 1, name: "CI Activity" })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("group", { name: "Project" })).getByRole("button", { name: "vLLM" }));
  await screen.findByRole("heading", { level: 2, name: "vLLM" });
  fireEvent.click(within(views).getByRole("link", { name: "Overview" }));
  await screen.findByRole("region", { name: "Upstream projects" });
  fireEvent.click(within(views).getByRole("link", { name: "CI Activity" }));
  expect(within(await screen.findByRole("group", { name: "Project" })).getByRole("button", { name: "vLLM" })).toHaveAttribute("aria-pressed", "true");
});

it("opens overview activity on the selected UTC day with platform filters", async () => {
  mount();
  const card = (await screen.findByRole("heading", { name: "llama.cpp" })).closest("article")!;
  expect(screen.queryByText(/Upstream means a test/)).not.toBeInTheDocument();
  fireEvent.focus(within(card).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" }));
  fireEvent.click(await screen.findByRole("link", { name: "View CI activity" }));
  expect(await screen.findByRole("region", { name: "Runs on 2026-10-27" })).toBeInTheDocument();
  const platforms = screen.getByRole("group", { name: "Platform" });
  expect(within(platforms).getByRole("button", { name: "Linux" })).toHaveAttribute("aria-pressed", "true");
  expect(within(platforms).getByRole("button", { name: "Windows" })).toBeDisabled();
});

it("filters platform evidence while keeping at least one platform selected", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[1].os = "windows";
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const platforms = await screen.findByRole("group", { name: "Platform" });
  fireEvent.click(within(platforms).getByRole("button", { name: "Windows" }));
  expect(await screen.findByText("of 4")).toBeInTheDocument();
  expect(within(platforms).getByRole("button", { name: "Windows" })).toHaveAttribute("aria-pressed", "false");
  expect(within(platforms).getByRole("button", { name: "Linux" })).toBeDisabled();
  fireEvent.click(within(platforms).getByRole("button", { name: "Windows" }));
  expect(await screen.findByText("of 12")).toBeInTheDocument();
});

it("uses independent inclusive stack and target toggles and a shared daily calendar", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  const stacks = await screen.findByRole("group", { name: "Stack" });
  const targets = screen.getByRole("group", { name: "Target" });
  for (const button of [...stacks.querySelectorAll("button[aria-pressed]"), ...targets.querySelectorAll("button[aria-pressed]")]) {
    expect(button).toHaveAttribute("aria-pressed", "true");
  }
  expect(screen.queryByRole("button", { name: "Everything AMD" })).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Project navigation" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "lemonade-sdk/llama.cpp" }).closest("details")).toBeNull();
  fireEvent.click(within(stacks).getByRole("button", { name: "rocm" }));
  expect(screen.getByText("of 8")).toBeInTheDocument();
  expect(within(stacks).getByRole("button", { name: "vulkan" })).toBeDisabled();
  fireEvent.click(within(targets).getByRole("button", { name: "gfx1201" }));
  expect(screen.getByText("No configured jobs match these filters.")).toBeInTheDocument();
  fireEvent.click(within(targets).getByRole("button", { name: "gfx1201" }));
  expect(screen.getByText("of 8")).toBeInTheDocument();
  fireEvent.click(within(stacks).getByRole("button", { name: "rocm" }));
  expect(screen.getByText("of 12")).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "Daily CI activity" })).toBeInTheDocument();
});

it("shows exact daily pass and failure counts and opens run evidence in a popup", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  const activity = await screen.findByRole("region", { name: "Daily activity" });
  const day = within(activity).getByRole("button", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" });
  expect(day.textContent).toBe("");
  expect(day.querySelector('.up-pass')).toBeInTheDocument();
  expect(day.querySelector('.up-fail')).toBeInTheDocument();
  fireEvent.click(day);
  const popup = await screen.findByRole("dialog", { name: "2026-10-27: 3 passed, 1 failed of 4 runs" });
  expect(await within(popup).findByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeInTheDocument();
  expect(within(popup).queryByRole("button", { name: "Previous day" })).not.toBeInTheDocument();
  expect(within(popup).queryByRole("button", { name: "Next day" })).not.toBeInTheDocument();
  fireEvent.click(within(popup).getByRole("button", { name: "Close popup" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps one daily failure visible even when more than 95 percent passed", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[0].daily["2026-10-27"].passed = 39;
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const activity = await screen.findByRole("region", { name: "Daily activity" });
  const day = within(activity).getByRole("button", { name: "2026-10-27: 39 passed, 1 failed of 40 runs" });
  expect(day.textContent).toBe("");
  fireEvent.click(day);
  expect(await screen.findByText(/40 runs/)).toBeInTheDocument();
  expect(screen.getByText("39", { selector: "dd" })).toBeInTheDocument();
  expect(screen.getByText("1", { selector: "dd" })).toBeInTheDocument();
  expect(day.querySelector(".up-fail")).toBeInTheDocument();
});

it("keeps saved day evidence accessible outside the visible chart window", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.window = { ...data.window, start: "2026-09-30", days: 30 };
  mount("/?track=upstream&view=ci&project=llamacpp&day=2026-10-01&activity=cat:tests", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const panel = await screen.findByRole("region", { name: "Runs on 2026-10-01" });
  fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Runs on 2026-10-01" })).not.toBeInTheDocument();
});

it("keeps a saved category selection dismissible when filters remove its chart row", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp&stack=vulkan&target=gfx1151&day=2026-10-27&activity=cat:tests");
  const panel = await screen.findByRole("region", { name: "Runs on 2026-10-27" });
  expect(within(panel).getByRole("button", { name: "Close" })).toBeInTheDocument();
});

it("lists individual CI jobs in a visible table with per-job run evidence", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  const table = await screen.findByRole("table", { name: "CI jobs" });
  expect(table.closest("details")).toBeNull();
  const row = within(table).getByRole("row", { name: /gpu-rocm/ });
  expect(within(table).queryByRole("columnheader", { name: "Stack" })).not.toBeInTheDocument();
  expect(within(row).getByRole("cell", { name: "Linux" })).toBeInTheDocument();
  fireEvent.focus(within(row).getByRole("button", { name: "gpu-rocm" }));
  const metadata = await screen.findByRole("dialog", { name: "gpu-rocm" });
  expect(within(metadata).getByText("rocm", { selector: "dd" })).toBeInTheDocument();
  expect(within(metadata).getByText("gfx1151", { selector: "dd" })).toBeInTheDocument();
  expect(within(metadata).getByText(/Pass rate.*14 days/)).toBeInTheDocument();
  fireEvent.blur(within(row).getByRole("button", { name: "gpu-rocm" }));
  fireEvent.click(within(row).getByRole("button", { name: "gpu-rocm · 2026-10-27: 3 passed, 1 failed of 4 runs" }));
  const popup = await screen.findByRole("dialog", { name: "gpu-rocm · 2026-10-27: 3 passed, 1 failed of 4 runs" });
  expect(await within(popup).findByRole("link", { name: "Job log at 10:00 UTC · failed" })).toBeInTheDocument();
  expect(within(popup).queryByRole("button", { name: "Previous day" })).not.toBeInTheDocument();
  expect(within(popup).queryByRole("button", { name: "Next day" })).not.toBeInTheDocument();
});

it("lists rare failing steps alongside frequent ones with exact counts and affected jobs", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[0].failed_steps = { "ccache-buckets-restore": 27, "Test archs": 1 };
  data.projects[0].jobs[1].failed_steps = { "ccache-buckets-restore": 1 };
  data.projects[0].jobs[1].label = data.projects[0].jobs[0].label;
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const table = await screen.findByRole("table", { name: "Failing steps on main" });
  const frequent = within(table).getByRole("row", { name: /ccache-buckets-restore/ });
  const rare = within(table).getByRole("row", { name: /Test archs/ });
  expect(within(frequent).getByRole("cell", { name: "28" })).toBeInTheDocument();
  expect(within(frequent).getByRole("cell", { name: "2" })).toBeInTheDocument();
  expect(within(rare).getAllByRole("cell", { name: "1" })).toHaveLength(2);
});

it("shows only 14 job dates even when the collection covers 30 days", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.window = { ...data.window, start: "2026-09-30", days: 30 };
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const table = await screen.findByRole("table", { name: "CI jobs" });
  expect(table.querySelectorAll("thead time")).toHaveLength(14);
  expect(within(table).getByRole("columnheader", { name: "2026-10-16 UTC" })).toBeInTheDocument();
  expect(within(table).queryByRole("columnheader", { name: "2026-10-01 UTC" })).not.toBeInTheDocument();
});

it.each(["llamacpp", "unsloth", "whispercpp"])("uses shared job outcomes and legends for %s", async (id) => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  const project = data.projects[0];
  project.id = id;
  project.label = id;
  project.jobs[0].daily["2026-10-27"] = { ...project.jobs[0].daily["2026-10-27"], passed: 19, failed: 1 };
  project.jobs[1].daily["2026-10-28"] = { ...project.jobs[1].daily["2026-10-28"], passed: 0, failed: 0, skipped: 8 };
  mount(`/?track=upstream&view=ci&project=${id}`, upstreamFetch({
    [new URL("upstream/overview.json", indexUrl).href]: data,
  }));
  const table = await screen.findByRole("table", { name: "CI jobs" });
  const failure = within(table).getByRole("button", { name: "gpu-rocm · 2026-10-27: 19 passed, 1 failed of 20 runs" });
  expect(failure.closest("td")).toHaveAttribute("data-outcome", "fail");
  expect(failure.querySelector('svg[data-outcome="fail"]')).toHaveAttribute("aria-hidden", "true");
  const skipped = within(table).getByRole("button", { name: "models-check vulkan-amd · 2026-10-28: 8 skipped" });
  expect(skipped.querySelector('svg[data-outcome="skip"]')).toHaveAttribute("aria-hidden", "true");
  const legend = screen.getByRole("list", { name: "CI job outcomes" });
  expect(within(legend).getByText("Skipped").closest("li")?.querySelector('svg[data-outcome="skip"]')).toBeInTheDocument();
});

it("formats CI job metadata as labeled qualification-style details", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  fireEvent.click(await screen.findByRole("button", { name: "gpu-rocm" }));
  const tooltip = await screen.findByRole("dialog", { name: "gpu-rocm" });
  for (const label of ["Category", "Workflow", "Cadence", "Stack", "Target", "Configured runner", "Pass rate (14 days)", "Decided results"])
    expect(within(tooltip).getByText(label, { selector: "dt" })).toBeInTheDocument();
});

it("presents run evidence in explicit labeled rows instead of abbreviated link clusters", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp&day=2026-10-27&activity=cat:tests");
  const panel = await screen.findByRole("region", { name: "Runs on 2026-10-27" });
  await within(panel).findByRole("link", { name: "Job log at 10:00 UTC · failed" });
  for (const label of ["Result", "Job log", "Failed step", "Commit", "Pull request", "PR CI result"])
    expect(within(panel).getAllByText(label, { selector: "dt" }).length).toBeGreaterThan(0);
});

it("keeps absent latest evidence unavailable instead of implying failure", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  fireEvent.focus(await screen.findByRole("button", { name: "gpu-rocm" }));
  const tooltip = await screen.findByRole("dialog", { name: "gpu-rocm" });
  expect(within(tooltip).getByText("Latest recorded result", { selector: "dt" })).toBeInTheDocument();
  expect(within(tooltip).getByText("Unavailable", { selector: "dd" })).toBeInTheDocument();
});

it("shows latest completion, log, and observed runner independently of historical rate", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  Object.assign(data.projects[0].jobs[0], { latest: {
    state: "other", conclusion: "cancelled", at: "2026-10-29T11:00:00Z",
    url: "https://github.com/example/demo/actions/runs/100", runner: "ephemeral-devlab-slot-1",
  }, devlab_observed: true, runner_evidence_text: "Observed on devlab · 14-day collection window" });
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  fireEvent.focus(await screen.findByRole("button", { name: "gpu-rocm" }));
  const tooltip = await screen.findByRole("dialog", { name: "gpu-rocm" });
  expect(within(tooltip).getByText("Cancelled")).toBeInTheDocument();
  expect(within(tooltip).getByText("2026-10-29 11:00 UTC")).toBeInTheDocument();
  expect(within(tooltip).getByRole("link", { name: "View latest job log" })).toHaveAttribute("href", "https://github.com/example/demo/actions/runs/100");
  expect(within(tooltip).getByText(/Observed on devlab/)).toBeInTheDocument();
  expect(within(tooltip).getByText("75%", { selector: "dd" })).toBeInTheDocument();
});

it("shows an overview DevLab indicator from observed upstream runner evidence", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[0].devlab_observed = true;
  data.projects[0].status_labels = [{ id: "coverage", text: "incomplete", tone: "neutral", tooltip: "Collection is incomplete." }, { id: "devlab", text: "devlab", tone: "neutral", tooltip: "gpu-rocm used an ephemeral-devlab-* runner in the collection window." }];
  data.projects[0].coverage.complete = false;
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  const card = (await screen.findByRole("heading", { name: "llama.cpp" })).closest("article")!;
  fireEvent.focus(within(card).getByRole("button", { name: "devlab" }));
  expect(await screen.findByText(/ephemeral-devlab-/)).toBeInTheDocument();
  expect(screen.getByText("incomplete")).toBeInTheDocument();
});
it("does not infer DevLab from configured runner descriptions", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[0].where = "DevLab";
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  await screen.findByRole("heading", { name: "llama.cpp" });
  expect(screen.queryByRole("button", { name: "devlab" })).not.toBeInTheDocument();
});

it("separates no-start test jobs from jobs with later unrun requests", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  const job = data.projects[0].jobs[0];
  job.started = 2;
  job.quiet_days = ["2026-10-29"];
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  const card = await screen.findByRole("region", { name: "llama.cpp upstream health" });
  expect(within(card).getByText("No runs observed").parentElement).toHaveTextContent("0");
  expect(within(card).getByText("Requests not started").parentElement).toHaveTextContent("1");
});

it("includes DevLab beside coverage in the CI Activity header", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].jobs[0].devlab_observed = true;
  data.projects[0].status_labels = [{ id: "coverage", text: "incomplete", tone: "neutral", tooltip: "Collection is incomplete." }, { id: "devlab", text: "devlab", tone: "neutral", tooltip: "gpu-rocm used an ephemeral-devlab-* runner in the collection window." }];
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  await screen.findByRole("heading", { name: "llama.cpp" });
  const header = document.querySelector(".up-page-head")! as HTMLElement;
  expect(within(header).getByLabelText("devlab")).toBeInTheDocument();
});

it("renders pipeline label text and tooltip verbatim without interpreting evidence", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  data.projects[0].status_labels = [{ id: "custom", text: "producer label", tone: "warning", tooltip: "Producer supplied explanation." }];
  data.projects[0].coverage.complete = false;
  data.projects[0].jobs[0].devlab_observed = true;
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  fireEvent.focus(await screen.findByRole("button", { name: "producer label" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Producer supplied explanation.");
  expect(screen.queryByRole("button", { name: "devlab" })).not.toBeInTheDocument();
});
it("does not invent labels for legacy datasets", async () => {
  const data = structuredClone(upstreamOverview) as unknown as UpstreamOverview;
  for (const project of data.projects) delete project.status_labels;
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  await screen.findByRole("heading", { name: "llama.cpp" });
  expect(document.querySelectorAll(".up-status-labels button")).toHaveLength(0);
});

it("shows collector-provided descriptions for all four summary metrics", async () => {
  const descriptions = {
    pass_rate: "Collector explanation of passed results",
    no_starts: "Collector explanation of no starts",
    later_requests: "Collector explanation of unstarted requests",
    merged_red: "Collector explanation of failed checks",
  };
  const data = { ...upstreamOverview, projects: upstreamOverview.projects.map((project) => ({
    ...project, metric_descriptions: descriptions,
  })) };
  mount('/?track=upstream&view=ci&project=llamacpp', upstreamFetch({
    [new URL('upstream/overview.json', indexUrl).href]: data,
  }));
  await screen.findByRole('heading', { name: 'llama.cpp', level: 2 });
  for (const [label, description] of [
    ['Collected results passed', descriptions.pass_rate],
    ['No runs observed', descriptions.no_starts],
    ['Requests not started', descriptions.later_requests],
    ['Merged with failed checks', descriptions.merged_red],
  ]) {
    const trigger = screen.getByLabelText(label);
    fireEvent.focus(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(description);
    fireEvent.blur(trigger);
  }
});

it("explains upstream filter scopes and shows OS icons", async () => {
  mount("/?track=upstream&view=ci&project=llamacpp");
  const platforms = await screen.findByRole("group", { name: "Platform" });
  expect(platforms.querySelector('[data-platform="linux"]')).not.toBeNull();
  expect(platforms.querySelector('[data-platform="windows"]')).not.toBeNull();
  fireEvent.focus(screen.getByRole("button", { name: "About Stack" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(/stack/i);
  expect(screen.queryByRole("button", { name: "About Platform" })).not.toBeInTheDocument();
});


it("hides stale and empty projects but retains incomplete collection notices", async () => {
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  const template = data.projects[0];
  data.projects = [
    { ...template, id: "stale", label: "Stale project", jobs: template.jobs.map(job => ({ ...job, daily: { "2026-10-15": { passed: 1, failed: 0, other: 0, running: 0, skipped: 0, stalled: 0, slow: 0 } } })) },
    { ...template, id: "failed-collection", label: "Collection problem", jobs: [], coverage: { complete: false, error: "API unavailable" } },
    { ...template, id: "active", label: "Active project" },
  ];
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  await screen.findByRole("heading", { name: "Active project" });
  expect(screen.queryByRole("heading", { name: "Stale project" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Collection problem" })).toBeVisible();
  expect(screen.getByText("Collection failed. The displayed results may be incomplete.")).toBeVisible();
  fireEvent.click(screen.getByText("Technical details"));
  expect(screen.getByText("API unavailable")).toBeVisible();
});

it("filters CI job rows by positive observations across the current UTC cutoff", async () => {
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  const template = data.projects[0].jobs[0];
  const empty = { passed: 0, failed: 0, other: 0, running: 0, skipped: 0, stalled: 0, slow: 0 };
  data.projects[0].jobs = [
    ...(["passed", "failed", "other", "running", "skipped", "stalled"] as const).map(state => ({ ...template, id: state, label: state, daily: { "2026-10-16": { ...empty, [state]: 1 } } })),
    { ...template, id: "stale", label: "Stale job", daily: { "2026-10-15": { ...empty, passed: 1 } } },
    { ...template, id: "future", label: "Future job", daily: { "2026-10-30": { ...empty, passed: 1 } } },
    { ...template, id: "zero", label: "Zero job", daily: { "2026-10-29": { ...empty, slow: 1 } } },
  ];
  mount("/?track=upstream&view=ci&project=llamacpp", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  const table = await screen.findByRole("table", { name: "CI jobs" });
  for (const state of ["passed", "failed", "other", "running", "skipped", "stalled"]) expect(within(table).getByRole("button", { name: state })).toBeVisible();
  for (const label of ["Stale job", "Future job", "Zero job"]) expect(within(table).queryByText(label)).not.toBeInTheDocument();
});

it("uses today's window instead of the collection date for upstream visibility", async () => {
  const data = structuredClone(upstreamOverview) as UpstreamOverview;
  data.projects = [data.projects[0]];
  data.projects[0].jobs = [{ ...data.projects[0].jobs[0], daily: { "2026-10-15": { passed: 1, failed: 0, other: 0, running: 0, skipped: 0, stalled: 0, slow: 0 } } }];
  mount("/?track=upstream", upstreamFetch({ [new URL("upstream/overview.json", indexUrl).href]: data }));
  expect(await screen.findByText("No upstream observations in the last 14 days.")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "llama.cpp" })).not.toBeInTheDocument();
});

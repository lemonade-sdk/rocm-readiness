import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Build, Session } from "../data";
import { index, indexUrl, overview, pointer } from "../fixtures";
import { findExactQualificationBuild, metricValue, PerformanceView } from "./PerformanceView";

type Measurement = {
  source_id?: string;
  engine?: string;
  channel?: string;
  backend?: string;
  fork_id?: string;
  engine_repository?: string;
  engine_version?: string;
  model?: string;
  scenario?: string;
  quant?: string | null;
  system_id?: string | null;
  context_size?: number | null;
  input_tokens?: number | null;
  measured_at?: string;
  rocm_version?: string | null;
  package_os?: string | null;
  package_url?: string | null;
  qualification_build_id?: string | null;
  metrics?: Record<string, number>;
};

const system = {
  id: "system-a",
  source_id: "lemonade-performance",
  cpu: "AMD Ryzen",
  gpu: "gfx1151",
  gpu_full: [
    { integrated: true, name: "AMD Radeon", type: "amd", vram_gb: 16 },
  ],
  os: "linux",
  memory: null,
  ram_gb: 64,
  vram_gb: 16,
  gfx_target: "gfx1151",
};

function measurement(overrides: Measurement = {}) {
  return {
    source_id: "lemonade-performance",
    engine: "llamacpp",
    channel: "stable",
    backend: "rocm",
    fork_id: "llamacpp-rocm-stable",
    engine_repository: "lemonade-sdk/llama.cpp",
    engine_version: "b100",
    model: "Model A",
    scenario: "short-prompt",
    quant: "Q4_K_M",
    system_id: "system-a",
    context_size: 4096,
    input_tokens: 128,
    measured_at: "2026-10-29T12:00:00Z",
    rocm_version: "10.1",
    package_os: "linux",
    package_url:
      "https://github.com/lemonade-sdk/llama.cpp/releases/download/b100/llama-b100-bin-ubuntu-rocm-10.1-x64.tar.gz",
    qualification_build_id: null,
    metrics: { tg_tps: 12, ttft_ms_mean: 250 },
    ...overrides,
  };
}

function performance(measurements: Measurement[], systems = [system]) {
  return { schema_version: 2, measurements, systems };
}

function historyBuild(overrides: Partial<Build> = {}): Build {
  return {
    build_id: "build-100",
    engine: "llamacpp",
    channel: "stable",
    rocm_version: "10.1",
    os: "linux",
    tag: "b100",
    generated_at: "2026-10-29T11:00:00Z",
    qualified: true,
    ...overrides,
  };
}

function sessionFor(
  currentMeasurements: Measurement[],
  options: {
    currentSystems?: typeof system[];
    benchmarkAssessment?: { message: string; last_run_label: string } | null;
    performanceStatus?: "available" | "not_measured";
    history?: Build[];
  } = {},
): { session: Session; responses: Record<string, unknown> } {
  const currentOverview = overview("10.1") as unknown as NonNullable<
    Session["overview"]
  >;
  currentOverview.history = [
    {
      month: "2026-10",
      path: "rocm/10.1/history/2026-10.json",
      build_count: options.history?.length ?? 0,
    },
  ];
  currentOverview.performance =
    options.performanceStatus === "not_measured"
      ? { status: "not_measured" }
      : {
          status: "available",
          measurement_count: currentMeasurements.length,
          path: "rocm/10.1/performance.json",
        };
  return {
    session: {
      pointer: pointer as unknown as Session["pointer"],
      index: index as unknown as Session["index"],
      indexUrl,
      version: "10.1",
      overview: currentOverview,
    },
    responses: {
      [new URL("rocm/10.1/performance.json", indexUrl).href]: {
        ...performance(currentMeasurements, options.currentSystems),
        benchmark_assessment: options.benchmarkAssessment,
      },
      [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
        schema_version: 2,
        rocm_version: "10.1",
        month: "2026-10",
        builds: options.history ?? [],
      },

    },
  };
}

function renderView(
  currentMeasurements: Measurement[],
  options: Parameters<typeof sessionFor>[1] & { query?: string } = {},
) {
  const { session, responses } = sessionFor(currentMeasurements, options);
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    return new Response(JSON.stringify(responses[url] ?? { error: "missing" }), {
      status: url in responses ? 200 : 404,
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const onNavigate = vi.fn();
  render(
    <PerformanceView
      session={session}
      params={
        new URLSearchParams(
          options.query ?? "version=10.1&view=performance&platform=all",
        )
      }
      onNavigate={onNavigate}
      buildHref={(buildId, platform) =>
        `?view=build&build=${buildId}&platform=${platform}`
      }
    />,
  );
  return { fetcher, onNavigate };
}

afterEach(() => vi.unstubAllGlobals());

describe("PerformanceView", () => {
  it("renders collector-owned benchmark copy without deriving it from filtered rows", async () => {
    renderView([measurement()], {
      benchmarkAssessment: {
        message: "Collector benchmark explanation for build b456.",
        last_run_label: "Collector benchmark date: 2026-10-28 UTC.",
      },
      query: "version=10.1&view=performance&model=missing",
    });
    expect(await screen.findByText("Collector benchmark explanation for build b456.")).toBeInTheDocument();
    const tableSection = screen.getByRole("region", { name: "Model performance" });
    expect(within(tableSection).getByText("Collector benchmark date: 2026-10-28 UTC.")).toBeInTheDocument();
    expect(within(tableSection).queryByText("Collector benchmark explanation for build b456.")).not.toBeInTheDocument();
    expect(screen.getByText(/HISTORICAL MEASUREMENTS/)).toBeInTheDocument();
  });

  it("does not invent benchmark freshness copy for legacy datasets", async () => {
    renderView([measurement()]);
    await screen.findByRole("button", { name: /Measurement details for Model A/ });
    expect(screen.queryByText(/Measurements are from benchmarked llama.cpp builds/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last run:/)).not.toBeInTheDocument();
  });

  it("converts source TTFT milliseconds to seconds for display", () => {
    expect(metricValue("ttft_ms_mean", 20817.47)).toBe("20.82 s");
    expect(metricValue("ttft_ms_best", 250)).toBe("0.25 s");
    expect(metricValue("tps_mean", 65)).toBe("65 tok/s");
  });

  it("requires one exact qualification history record rather than choosing the first matching source", () => {
    const row = measurement({ qualification_build_id: "build-100" });
    const first = historyBuild({
      artifact: "llama-b100-bin-ubuntu-rocm-10.1-x64.tar.gz",
      source_url:
        "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/qualification/index.json",
    });
    const second = historyBuild({
      artifact: "llama-b100-bin-ubuntu-rocm-10.1-x64.tar.gz",
      source_id: "another-stable-source",
      source_url:
        "https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/qualification/index.json",
    });

    expect(findExactQualificationBuild(row, [first, second])).toBeUndefined();
  });

  it("shows nightly metrics and links the exact nightly qualification build", async () => {
    const row = measurement({
      channel: "nightly",
      fork_id: "llamacpp-rocm-nightly",
      engine_repository: "lemonade-sdk/llamacpp-rocm",
      qualification_build_id: "build-100",
      package_url: "https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b100/llama-b100-ubuntu-rocm-gfx1151-x64.tar.gz",
    });
    renderView([row], {
      query: "version=10.1&view=model&model=Model+A",
      history: [historyBuild({
        channel: "nightly",
        artifact: "llama-b100-ubuntu-rocm-gfx1151-x64.tar.gz",
        source_url: "https://raw.githubusercontent.com/lemonade-sdk/llamacpp-rocm/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/qualification/index.json",
      })],
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Measurement details for Model A/ }));
    expect(await screen.findByText("12 tok/s")).toBeInTheDocument();
    expect(screen.getByText("nightly", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open matching package record" }))
      .toHaveAttribute("href", "?view=build&build=build-100&platform=linux");
    expect(findExactQualificationBuild(row, [historyBuild()])).toBeUndefined();
  });

  it("shows compact metrics in one table and opens evidence without navigating", async () => {
    const { onNavigate } = renderView([measurement({ scenario: "context-32k", context_size: 32768,
      metrics: { tps_mean: 999, pp_tps: 142, tg_tps: 42, ttft_ms_mean: 250, tps_p95: 777, vram_peak_gb: 18.5 } })]);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("42")).toBeInTheDocument();
    expect(within(table).getByText("142")).toBeInTheDocument();
    const headings = within(table).getAllByRole("columnheader").map((node) => node.textContent?.replace(/[↕↑↓]/g, ""));
    expect(headings).toEqual(["Build", "Model", "Prefill TPS", "Decode TPS", "CTX size", "Peak VRAM"]);
    for (const value of ["999", "777", "0.25"]) expect(within(table).queryByText(value)).not.toBeInTheDocument();
    expect(within(table).getByText("18.5")).toBeInTheDocument();
    expect(within(table).getAllByText("32K")).toHaveLength(1);
    expect(within(table).queryByRole("columnheader", { name: "Test" })).not.toBeInTheDocument();
    expect(within(table).getByRole("img", { name: "Linux" })).toBeInTheDocument();
    expect(within(table).queryByText("Linux")).not.toBeInTheDocument();
    expect(table).toHaveClass("qualification-table");
    expect(within(table).queryByRole("columnheader", { name: "Quant" })).not.toBeInTheDocument();
    expect(within(table).getByText("b100")).toBeInTheDocument();
    const filters = screen.getByLabelText("Performance filters");
    expect(within(filters).getByRole("combobox", { name: "Model" })).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: /^Measurement details/ }));
    const evidence = await screen.findByRole("dialog");
    expect(evidence).toHaveClass("qualification-popup");
    for (const name of ["Performance", "Test configuration", "Hardware", "Package and benchmark", "Qualification"])
      expect(within(evidence).getByRole("heading", { name })).toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Back to models")).not.toBeInTheDocument();
  });

  it("shows missing split throughput without substituting aggregate TPS", async () => {
    renderView([measurement({ metrics: { tps_mean: 999, tps_p95: 777 }, context_size: null, scenario: "context-4k" })]);
    const table = await screen.findByRole("table");
    expect(within(table).queryByText("999")).not.toBeInTheDocument();
    expect(within(table).getByText("4K")).toBeInTheDocument();
    const missing = within(table).getByRole("button", { name: "Prefill TPS unavailable" });
    expect(missing).toHaveTextContent("—");
    fireEvent.click(missing);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Prefill throughput was not recorded for this benchmark.");
    expect(within(table).getByRole("button", { name: "Decode TPS unavailable" })).toHaveTextContent("—");
  });

  it("keeps older builds visible while selecting latest configurations within each build", async () => {
    const { onNavigate } = renderView([
      measurement({ engine_version: "b99", measured_at: "2026-10-28T12:00:00Z", system_id: null, metrics: { tg_tps: 10 } }),
      measurement({ engine_version: "b100", metrics: { pp_tps: 44, tg_tps: 42, tps_p95: 444 } }),
      measurement({ engine_version: "b100", scenario: "context-32k", context_size: 32768 }),
      measurement({ engine_version: "b100", system_id: "system-b" }),
    ]);
    const table = await screen.findByRole("table");
    expect(table.querySelectorAll(".performance-measurement-row")).toHaveLength(4);
    expect(within(table).getByText(/b99/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Recorded tests" })).not.toBeInTheDocument();
    expect(within(table).getByText("42")).toBeInTheDocument();
    expect(within(table).getByText("44")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Show history" })).not.toBeInTheDocument();
  });

  it("ignores legacy history flags and retains measured builds", async () => {
    renderView([measurement(), measurement({ engine_version: "b99", measured_at: "2026-10-28T12:00:00Z" })],
      { query: "version=10.1&view=performance&performance_history=all" });
    const table = await screen.findByRole("table");
    expect(table.querySelectorAll(".performance-measurement-row")).toHaveLength(2);
    expect(within(table).getByText(/b99/)).toBeInTheDocument();
  });

  it("groups nightly measurements under the build and verified package GPU family", async () => {
    renderView([measurement({ channel: "nightly", engine_version: "b1355",
      package_url: "https://github.com/lemonade-sdk/llamacpp-rocm/releases/download/b1355/llama-b1355-ubuntu-rocm-gfx1151-x64.zip" })]);
    const table = await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Build b1355" })).toBeInTheDocument();
    expect(within(table).getByText("gfx1151")).toBeInTheDocument();
    expect(within(table).queryByText("nightly")).not.toBeInTheDocument();
  });

  it("searches builds and resets the performance scope while retaining the version", async () => {
    const { onNavigate } = renderView([measurement(), measurement({ engine_version: "b99" })],
      { query: "view=performance&version=10.1&build_filter=b100&model=Model+A&workload=short-prompt&platform=linux" });
    const table = await screen.findByRole("table");
    expect(within(table).queryByText("b99")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    const next = onNavigate.mock.calls.at(-1)?.[0] as URLSearchParams;
    expect(next.get("version")).toBe("10.1");
    for (const key of ["build_filter", "model", "workload", "platform", "build", "observation"]) expect(next.has(key)).toBe(false);
    expect(screen.queryByText(/All performance data/)).not.toBeInTheDocument();
  });

  it("sorts model rows within each build and keeps missing values last", async () => {
    renderView([measurement({ model: "Slow", metrics: { tg_tps: 10 } }),
      measurement({ model: "Fast", metrics: { tg_tps: 30 } }),
      measurement({ model: "Missing", metrics: {} }),
      measurement({ model: "Other build", engine_version: "b99", metrics: { tg_tps: 100 } })],
      { query: "version=10.1&view=performance&sort=tps&direction=desc" });
    const table = await screen.findByRole("table");
    const names = [...table.querySelectorAll(".performance-model-trigger")].map((node) => node.textContent);
    expect(names).toEqual(["Fast", "Slow", "Missing", "Other build"]);
    expect(screen.getByRole("button", { name: "Decode TPS definition" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CTX size definition" })).toBeInTheDocument();
  });

  it("ranks builds by the selected metric only for one complete compatible cohort", async () => {
    renderView([measurement({ metrics: { tg_tps: 10 } }),
      measurement({ engine_version: "b99", metrics: { tg_tps: 30 } })],
      { query: "version=10.1&view=performance&sort=tps&direction=desc&build_order=metric" });
    const table = await screen.findByRole("table");
    expect([...table.querySelectorAll('th[scope="rowgroup"]')].map((node) => node.textContent)).toEqual(["b99", "b100"]);
    expect(screen.getByRole("option", { name: "Selected metric" })).not.toBeDisabled();
  });

  it("does not rank unlike workloads even when a metric-order URL requests it", async () => {
    renderView([measurement(), measurement({ engine_version: "b99", scenario: "other", metrics: { tg_tps: 100 } })],
      { query: "version=10.1&view=performance&sort=tps&direction=desc&build_order=metric" });
    const table = await screen.findByRole("table");
    expect([...table.querySelectorAll('th[scope="rowgroup"]')].map((node) => node.textContent)).toEqual(["b100", "b99"]);
    expect(screen.getByRole("option", { name: "Selected metric" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Ryzen.*AMD Radeon/ })).toHaveAttribute("title", "system-a");
  });

  it("highlights individual filters and toggles a choice off without All buttons", async () => {
    const { onNavigate } = renderView([measurement(), measurement({ package_os: "windows", scenario: "long-prompt" })]);
    await screen.findAllByRole("button", { name: /^Measurement details for Model A/ });
    expect(screen.queryByRole("button", { name: /^All (platforms|systems|workloads)$/ })).not.toBeInTheDocument();
    const platforms = within(screen.getByRole("group", { name: "Measurement platform" }));
    expect(platforms.getByRole("button", { name: "Linux" })).toHaveAttribute("aria-pressed", "true");
    expect(platforms.getByRole("button", { name: "Windows" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(platforms.getByRole("button", { name: "Windows" }));
    expect(onNavigate.mock.calls.at(-1)?.[0].getAll("platform")).toEqual(["linux"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Workload" })).getByRole("button", { name: "long-prompt" }));
    expect(onNavigate.mock.calls.at(-1)?.[0].getAll("workload")).toEqual(["short-prompt"]);
  });

  it("ignores legacy comparison parameters without fetching another version", async () => {
    const { fetcher } = renderView([measurement()], { query: "version=10.1&view=performance&compare=10.2" });
    await screen.findByRole("button", { name: /^Measurement details for Model A/ });
    expect(screen.queryByText("Compare ROCm version")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("10.2"))).toBe(false);
  });

  it("shows an unmeasured version without requesting its performance file", async () => {
    const { fetcher } = renderView([], { performanceStatus: "not_measured" });
    expect(
      screen.getByText("No recorded model measurements for ROCm 10.1"),
    ).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows a missing metric state without inventing a unit or value", async () => {
    renderView([measurement({ metrics: {} })], {
      query: "version=10.1&view=model&model=Model%20A",
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Measurement details for Model A/ }));
    await waitFor(() =>
      expect(screen.getByText("No reported metrics")).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("dialog")).queryByText(/tok\/s/)).not.toBeInTheDocument();
  });

  it("does not turn package attribution into a qualification verdict without an exact history record", async () => {
    renderView(
      [
        measurement({
          qualification_build_id: "build-100",
          engine_version: "b100",
        }),
      ],
      {
        history: [historyBuild({ tag: "b101" })],
        query: "version=10.1&view=model&model=Model%20A",
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Measurement details for Model A/ }));
    await waitFor(() =>
      expect(
        screen.getByText("No matching qualification history record"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Package qualification: Qualified")).not.toBeInTheDocument();
  });

  it("applies model, system, workload, and measurement-platform URL filters and preserves unrelated parameters on model navigation", async () => {
    const { onNavigate } = renderView(
      [
        measurement(),
        measurement({ model: "Model B" }),
        measurement({ scenario: "long-prompt" }),
        measurement({ system_id: "system-b" }),
        measurement({ package_os: "windows" }),
      ],
      {
        currentSystems: [system, { ...system, id: "system-b" }],
        query:
          "version=10.1&view=performance&model=Model%20A&system=system-a&workload=short-prompt&platform=linux&keep=1",
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Measurement details for Model A/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /^Measurement details for Model B/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "Model A" } });
    const next = onNavigate.mock.calls[0][0] as URLSearchParams;
    expect(next.get("view")).toBe("performance");
    expect(next.get("model")).toBe("Model A");
    expect(next.get("system")).toBe("system-a");
    expect(next.get("workload")).toBe("short-prompt");
    expect(next.get("platform")).toBe("linux");
    expect(next.get("version")).toBe("10.1");
    expect(next.get("keep")).toBe("1");
  });
});


it("shows phone measurement cards with inline evidence and source metric units", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  renderView([measurement({ metrics: { tg_tps: 12, ttft_ms_mean: 250 }, model: "Long model name", qualification_build_id: null })]);
  const card = await screen.findByRole("article", { name: "Long model name · short-prompt" });
  expect(within(card).getByRole("heading", { name: "Long model name" })).toBeVisible();
  expect(within(card).getAllByText("12 tok/s")[0]).toBeVisible();
  expect(within(card).getAllByText("0.25 s")[0]).toBeVisible();
  expect(within(card).getAllByText("Not recorded")[0]).toBeVisible();
  const disclosure = within(card).getByText("Evidence & configuration");
  fireEvent.click(disclosure);
  expect(within(card).getByText("Test configuration")).toBeVisible();
  expect(within(card).getByText("No qualification build is identified for this package.")).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Build, Session } from "../data";
import { index, indexUrl, overview, pointer } from "../fixtures";
import {
  findExactQualificationBuild,
  PerformanceView,
} from "./PerformanceView";

type Measurement = {
  run_url?: string;
  source_url?: string;
  lemonade_version?: string;
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
    lemonade_version: "v2026.43.3",
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
    baselineMeasurements?: Measurement[];
    compareMeasurements?: Measurement[];
    currentSystems?: (typeof system)[];
    compareSystems?: (typeof system)[];
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
  const compareOverview = overview("10.2") as unknown as NonNullable<
    Session["overview"]
  >;
  compareOverview.history = [
    {
      month: "2026-10",
      path: "rocm/10.2/history/2026-10.json",
      build_count: 0,
    },
  ];
  compareOverview.performance = {
    status: "available",
    measurement_count: options.compareMeasurements?.length ?? 0,
    path: "rocm/10.2/performance.json",
  };
  return {
    session: {
      pointer: pointer as unknown as Session["pointer"],
      index: {
        ...index,
        ...(options.baselineMeasurements
          ? {
              comparison_performance: {
                count: options.baselineMeasurements.length,
                path: "performance/comparisons.json",
              },
            }
          : {}),
      } as unknown as Session["index"],
      indexUrl,
      version: "10.1",
      overview: currentOverview,
    },
    responses: {
      [new URL("performance/comparisons.json", indexUrl).href]: performance(
        options.baselineMeasurements ?? [],
      ),
      [new URL("rocm/10.1/performance.json", indexUrl).href]: performance(
        currentMeasurements,
        options.currentSystems,
      ),
      [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]: {
        schema_version: 2,
        rocm_version: "10.1",
        month: "2026-10",
        builds: options.history ?? [],
      },
      [new URL("rocm/10.2/overview.json", indexUrl).href]: compareOverview,
      [new URL("rocm/10.2/performance.json", indexUrl).href]: performance(
        options.compareMeasurements ?? [],
        options.compareSystems,
      ),
      [new URL("rocm/10.2/history/2026-10.json", indexUrl).href]: {
        schema_version: 2,
        rocm_version: "10.2",
        month: "2026-10",
        builds: [],
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
    return new Response(
      JSON.stringify(responses[url] ?? { error: "missing" }),
      {
        status: url in responses ? 200 : 404,
      },
    );
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

  it("compares deterministic latest observations only when exact hardware and workload identities match", async () => {
    renderView(
      [
        measurement({
          metrics: { tg_tps: 12 },
          measured_at: "2026-10-29T13:00:00Z",
        }),
      ],
      {
        query: "version=10.1&view=performance&compare=10.2",
        compareMeasurements: [
          measurement({
            rocm_version: "10.2",
            metrics: { tg_tps: 9 },
            measured_at: "2026-10-28T11:00:00Z",
          }),
          measurement({
            rocm_version: "10.2",
            metrics: { tg_tps: 10 },
            measured_at: "2026-10-28T12:00:00Z",
          }),
        ],
        compareSystems: [system],
      },
    );

    await waitFor(() =>
      expect(screen.getByText("ROCm 10.2 comparison")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Δ \+2(?:\.0+)? tok\/s/)).toBeInTheDocument();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThanOrEqual(2);
  });

  it("leaves hardware, quant, workload, and context mismatches explicitly unmatched", async () => {
    renderView([measurement()], {
      query: "version=10.1&view=performance&compare=10.2",
      compareMeasurements: [
        measurement({ rocm_version: "10.2", system_id: "other-system" }),
        measurement({ rocm_version: "10.2", quant: "Q8_0" }),
        measurement({ rocm_version: "10.2", scenario: "long-prompt" }),
        measurement({ rocm_version: "10.2", context_size: 8192 }),
      ],
      compareSystems: [system, { ...system, id: "other-system" }],
    });

    await waitFor(() =>
      expect(screen.getByText("No compatible comparison")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/1 selected observation.*unmatched/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/4 ROCm 10\.2 observations.*unmatched/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Δ /)).not.toBeInTheDocument();
  });

  it("does not compare observations whose hardware or context metadata is absent", async () => {
    renderView(
      [
        measurement({
          system_id: null,
          context_size: null,
          input_tokens: null,
          package_url: null,
        }),
      ],
      {
        query: "version=10.1&view=performance&compare=10.2",
        compareMeasurements: [
          measurement({
            rocm_version: "10.2",
            system_id: null,
            context_size: null,
            input_tokens: null,
            package_url: null,
          }),
        ],
        currentSystems: [],
        compareSystems: [],
      },
    );

    await waitFor(() =>
      expect(screen.getByText("No compatible comparison")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Missing hardware or workload metadata/),
    ).toBeInTheDocument();
  });

  it("requires complete published hardware records instead of trusting a shared system ID", async () => {
    const incompleteSystem = {
      id: "system-a",
      source_id: "lemonade-performance",
      cpu: null,
      gpu: null,
      os: null,
      ram_gb: null,
      vram_gb: null,
    } as unknown as typeof system;
    renderView([measurement()], {
      query: "version=10.1&view=performance&compare=10.2",
      compareMeasurements: [measurement({ rocm_version: "10.2" })],
      currentSystems: [incompleteSystem],
      compareSystems: [incompleteSystem],
    });

    await waitFor(() =>
      expect(screen.getByText("No compatible comparison")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Missing hardware or workload metadata/),
    ).toBeInTheDocument();
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
    await waitFor(() =>
      expect(screen.getByText("No reported metrics")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
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
    await waitFor(() =>
      expect(
        screen.getByText("No matching stable qualification history record"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Package qualification: Qualified"),
    ).not.toBeInTheDocument();
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
      expect(screen.getByRole("link", { name: "Model A" })).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: "Model B" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Model A" }));
    const next = onNavigate.mock.calls[0][0] as URLSearchParams;
    expect(next.get("view")).toBe("model");
    expect(next.get("model")).toBe("Model A");
    expect(next.get("system")).toBe("system-a");
    expect(next.get("workload")).toBe("short-prompt");
    expect(next.get("platform")).toBe("linux");
    expect(next.get("version")).toBe("10.1");
    expect(next.get("keep")).toBe("1");
  });
});

describe("focused model detail", () => {
  it("keeps the fixed ordinary Gemma reference at Q4 and 32K without substituting MTP or 4K", async () => {
    renderView(
      [
        measurement({
          model: "Gemma-4-31B-it-GGUF",
          context_size: 32768,
          scenario: "context-32k",
          engine_version: "b11932",
          metrics: { tg_tps: 15, ttft_ms_mean: 1250 },
        }),
        measurement({
          model: "Gemma-4-31B-it-GGUF",
          context_size: 4096,
          scenario: "context-4k",
          engine_version: "wrong-4k",
        }),
        measurement({
          model: "Gemma-4-31B-it-GGUF",
          context_size: 32768,
          scenario: "context-32k",
          quant: "Q8_0",
          engine_version: "wrong-quant",
        }),
        measurement({
          model: "Gemma-4-31B-it-GGUF-MTP",
          context_size: 32768,
          scenario: "context-32k",
          engine_version: "wrong-mtp",
        }),
      ],
      {
        query:
          "version=10.1&view=model&model=Gemma-4-31B-it-GGUF&reference=gemma-31b-32k&workload=context-32k",
      },
    );
    await screen.findByRole("region", { name: "Model measurement history" });
    expect(screen.getAllByText("b11932").length).toBeGreaterThan(0);
    expect(screen.queryByText("wrong-4k")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-quant")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-mtp")).not.toBeInTheDocument();
    expect(screen.getByText("1.25 s")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Model", { selector: "select" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Answer accuracy: unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Vulkan baseline unavailable in this dataset."),
    ).toBeInTheDocument();
  });

  it("shows compatible points separately from incomplete historical observations", async () => {
    renderView(
      [
        measurement({
          measured_at: "2026-10-28T12:00:00Z",
          metrics: { tg_tps: 10 },
        }),
        measurement({
          measured_at: "2026-10-29T12:00:00Z",
          metrics: { tg_tps: 15 },
        }),
        measurement({ system_id: null, engine_version: "old-unidentified" }),
      ],
      { query: "version=10.1&view=model&model=Model%20A" },
    );
    await screen.findByRole("region", { name: "Model measurement history" });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByText(/1 observation excluded from comparable history/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/old-unidentified/)[0]).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Series 1 observations" }),
    ).toBeInTheDocument();
  });

  it("does not assign older model measurements to a newer selected qualification build", async () => {
    renderView([measurement({ qualification_build_id: "build-100" })], {
      history: [historyBuild()],
      query:
        "version=10.1&view=engine&engine=llamacpp&build=new-build&platform=linux",
    });
    await screen.findByText(/No exactly associated model measurements/);
    expect(
      screen.queryByRole("link", { name: "Model A" }),
    ).not.toBeInTheDocument();
  });
});

describe("scope restoration", () => {
  it("matches qualification dates in UTC and preserves the scoped engine return URL", async () => {
    const { onNavigate } = renderView(
      [measurement({ qualification_build_id: "build-100" })],
      {
        history: [
          historyBuild({
            generated_at: "2026-10-28T23:30:00-04:00",
            source_id: "qualification-source",
          }),
        ],
        query:
          "version=10.1&view=engine&engine=llamacpp&channel=stable&source=qualification-source&date=2026-10-29&platform=linux",
      },
    );
    const link = await screen.findByRole("link", { name: "Model A" });
    const next = new URL(link.getAttribute("href")!, "https://example.test")
      .searchParams;
    expect(next.get("return_view")).toBe("engine");
    expect(next.get("source")).toBe("qualification-source");
    expect(next.get("date")).toBe("2026-10-29");
    fireEvent.click(link);
    expect(
      (onNavigate.mock.calls[0][0] as URLSearchParams).get("return_view"),
    ).toBe("engine");
  });
  it("does not show a cross-version comparison outside a narrowed qualification scope", async () => {
    renderView([measurement()], {
      query: "version=10.1&view=engine&date=2026-11-02&compare=10.2",
      compareMeasurements: [measurement({ rocm_version: "10.2" })],
    });
    await screen.findByText(
      "No stable llama.cpp ROCm measurements match these filters.",
    );
    expect(screen.queryByText("ROCm 10.2 comparison")).not.toBeInTheDocument();
  });
});

describe("fixed reference Vulkan baseline", () => {
  const reference = {
    model: "Gemma-4-31B-it-GGUF",
    scenario: "context-32k",
    context_size: 32768,
    input_tokens: 24035,
    lemonade_version: "v2026.43.3",
    run_url:
      "https://github.com/lemonade-sdk/lemonade/actions/runs/40537509555",
  };
  it("uses system OS for a null-ROCm Vulkan baseline and preserves both actual packages", async () => {
    renderView(
      [
        measurement({
          ...reference,
          engine_version: "b11932",
          metrics: { tg_tps: 15 },
        }),
      ],
      {
        query:
          "version=10.1&view=model&model=Gemma-4-31B-it-GGUF&reference=gemma-31b-32k&workload=context-32k",
        baselineMeasurements: [
          measurement({
            ...reference,
            backend: "vulkan",
            channel: "reference",
            fork_id: "llamacpp-upstream-vulkan",
            engine_repository: "ggml-org/llama.cpp",
            engine_version: "b11946",
            rocm_version: null,
            package_os: null,
            package_url: null,
            metrics: { tg_tps: 12 },
          }),
        ],
      },
    );
    await screen.findByRole("table", {
      name: "Observed backend configurations",
    });
    expect(
      screen.getByText(/vulkan · ggml-org\/llama.cpp · b11946/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Vulkan is baseline evidence with no ROCm qualification/,
      ),
    ).toBeInTheDocument();
  });
  it("does not compare a baseline with unknown input settings", async () => {
    renderView([measurement({ ...reference })], {
      query:
        "version=10.1&view=model&model=Gemma-4-31B-it-GGUF&reference=gemma-31b-32k&workload=context-32k",
      baselineMeasurements: [
        measurement({
          ...reference,
          backend: "vulkan",
          rocm_version: null,
          package_os: null,
          input_tokens: null,
          package_url: null,
        }),
      ],
    });
    await screen.findByText(
      "No compatible Vulkan baseline with complete hardware and workload metadata.",
    );
    expect(
      screen.queryByRole("table", { name: "Observed backend configurations" }),
    ).not.toBeInTheDocument();
  });
  it("rejects baseline evidence carrying a ROCm qualification identity", async () => {
    renderView([measurement({ ...reference })], {
      query:
        "version=10.1&view=model&model=Gemma-4-31B-it-GGUF&reference=gemma-31b-32k&workload=context-32k",
      baselineMeasurements: [
        measurement({
          ...reference,
          backend: "vulkan",
          rocm_version: null,
          package_os: null,
          package_url: null,
          qualification_build_id: "forged-build",
        }),
      ],
    });
    await screen.findByText(
      /Baseline has conflicting ROCm package or qualification identity/,
    );
    expect(
      screen.queryByRole("table", { name: "Observed backend configurations" }),
    ).not.toBeInTheDocument();
  });
});

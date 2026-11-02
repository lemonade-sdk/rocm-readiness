export const commit = "a".repeat(40);
export const indexUrl = `https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/${commit}/data/index.json`;
export const sync = {
  status: "success",
  attempted_at: "2026-10-29T16:20:05Z",
  last_successful_at: "2026-10-29T16:20:05Z",
  errors: [],
};
export const pointer = {
  schema_version: 1,
  data_commit: commit,
  index_url: indexUrl,
  sync,
};
export const index = {
  schema_version: 2,
  generated_at: sync.attempted_at,
  default_version: "10.1",
  versions: [
    {
      rocm_version: "10.1",
      overview: "rocm/10.1/overview.json",
      build_count: 26,
    },
    {
      rocm_version: "10.0",
      overview: "rocm/10.0/overview.json",
      build_count: 12,
    },
  ],
};
export function overview(version = "10.1") {
  return {
    schema_version: 2,
    generated_at: sync.attempted_at,
    rocm_version: version,
    engines: [
      {
        id: "llamacpp",
        label: "llama.cpp",
        build_count: version === "10.1" ? 26 : 12,
        platforms: ["linux", "windows"],
        latest_builds: [
          {
            build_id: "linux-build",
            source_id: "llamacpp-stable-qualification",
            source_url: `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${commit}/qualification/index.json`,
            engine: "llamacpp",
            channel: "stable",
            os: "linux",
            tag: "b11972",
            rocm_version: version,
            qualified: true,
            overall: "pass",
            hardware_validated: true,
            generated_at: sync.attempted_at,
            report_url: `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${commit}/qualification/reports/linux-build.json`,
          },
        ],
      },
    ],
    history: [
      {
        month: "2026-10",
        path: `rocm/${version}/history/2026-10.json`,
        build_count: version === "10.1" ? 26 : 12,
      },
    ],
    performance: {
      status: "available",
      measurement_count: 0,
      path: `rocm/${version}/performance.json`,
      latest_measurements: [],
    },
  };
}
export function fixtureFetch(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/main/data/latest.json":
      pointer,
    [indexUrl]: index,
    [new URL("rocm/10.1/overview.json", indexUrl).href]: overview(),
    [new URL("rocm/10.0/overview.json", indexUrl).href]: overview("10.0"),
    [new URL("rocm/10.1/history/2026-10.json", indexUrl).href]:
      historyFixture(),
    [new URL("rocm/10.0/history/2026-10.json", indexUrl).href]:
      historyFixture("10.0"),
    ...overrides,
  };
  return async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    return new Response(JSON.stringify(data[url] ?? { error: "not found" }), {
      status: url in data ? 200 : 404,
    });
  };
}

export function historyFixture(version = "10.1") {
  return {
    schema_version: 2,
    rocm_version: version,
    month: "2026-10",
    builds: Array.from({ length: version === "10.1" ? 26 : 12 }, (_, i) => ({
      ...overview(version).engines[0].latest_builds[0],
      build_id: i === 0 ? "linux-build" : `history-${i}`,
      report_url: `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${commit}/qualification/reports/${i === 0 ? "linux-build" : `history-${i}`}.json`,
      overall: i % 2 ? "warn" : "pass",
      os: i % 2 ? "windows" : "linux",
    })),
  };
}

export function executionAttempt(
  version = "10.1",
  status: "passed" | "failed" | "partial" | "unknown" = "failed",
) {
  return {
    source_id: "benchmark-fixture",
    source_url: `https://raw.githubusercontent.com/example/reports/${commit}/results/${status}.json`,
    source_pointer: "/models/0/results/0/scenarios/0",
    engine: "llamacpp",
    channel: "stable" as const,
    rocm_version: version,
    engine_version: "b-fixture",
    model: `fixture-${status}`,
    execution_status: status,
    measured_at: "2026-10-29T12:00:00Z",
    package_os: "linux",
    package_url:
      "https://github.com/example/engine/releases/download/b-fixture/package.tar.gz",
    scenario: "fixture-workload",
    context_size: 4096,
    hardware: {
      cpu: "Fixture CPU",
      gpu: [{ name: "Fixture GPU" }],
      os: "linux",
    },
  };
}

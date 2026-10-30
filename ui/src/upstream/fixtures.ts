import { fixtureFetch, index, indexUrl } from "../fixtures";

const cell = (passed: number, failed = 0, extra: Record<string, number> = {}) => ({
  passed,
  failed,
  other: 0,
  stalled: 0,
  skipped: 0,
  running: 0,
  slow: 0,
  ...extra,
});

function job(overrides: Record<string, unknown>) {
  return {
    workflow: "ci.yml",
    where: "Strix Halo",
    cadence: "per push",
    skipped: 0,
    stalled: 0,
    quiet_days: [],
    median_queue_seconds: 60,
    failed_steps: {},
    gate: null,
    ...overrides,
  };
}

export const upstreamOverview = {
  schema_version: 1,
  generated_at: "2026-10-29T16:20:05Z",
  window: { start: "2026-10-16", end: "2026-10-29", days: 14 },
  client_rule: { targets: ["gfx1151", "gfx1201"] },
  projects: [
    {
      id: "llamacpp",
      label: "llama.cpp",
      repository: "ggml-org/llama.cpp",
      default_branch: "master",
      forks: [{ repository: "lemonade-sdk/llama.cpp", role: "ROCm stable builds", channel: "stable" }],
      badge: { state: "up", reason: "tested on main on gfx1201 (models-check rocm)" },
      kpis: { decided: 12, passed: 9, pass_rate: 75, not_running: 1, merged_red: 1 },
      jobs: [
        job({
          id: "gpu-rocm",
          label: "gpu-rocm",
          category: "tests",
          target: "gfx1151",
          stack: "rocm",
          os: "linux",
          daily: { "2026-10-27": cell(3, 1), "2026-10-29": cell(0, 0, { stalled: 2 }) },
          decided: 4,
          passed: 3,
          started: 4,
          stalled: 2,
          last_ran: "2026-10-27",
          quiet_days: ["2026-10-29"],
          failed_steps: { Test: 1 },
          gate: {
            merged: 3,
            passed: 1,
            failed: 1,
            not_triggered: 1,
            no_result: 0,
            red: [
              {
                number: 501,
                url: "https://github.com/ggml-org/llama.cpp/pull/501",
                author: "dev",
                verdict: "failed",
                check_url: "https://github.com/ggml-org/llama.cpp/runs/9",
                main: "failed",
                main_url: "https://github.com/ggml-org/llama.cpp/actions/runs/1/job/11",
              },
            ],
            escaped: [],
          },
        }),
        job({
          id: "models-check-vulkan",
          label: "models-check vulkan-amd",
          category: "tests",
          target: "gfx1201",
          stack: "vulkan",
          os: "linux",
          daily: { "2026-10-28": cell(6, 2) },
          decided: 8,
          passed: 6,
          started: 8,
          last_ran: "2026-10-28",
        }),
      ],
      platforms: {
        linux: { built: true, built_rate: null, tested: true, tested_rate: 75, shipped: "ubuntu-rocm archive" },
        windows: { built: false, built_rate: null, tested: false, tested_rate: null, shipped: "win-rocm archive" },
      },
      findings: [
        { kind: "not_running", job: "gpu-rocm", head: "gpu-rocm has not run on a machine since 2026-10-27.", body: "Nothing turns red." },
      ],
      coverage: { complete: true },
      files: [{ month: "2026-10", path: "upstream/llamacpp/ci/2026-10.json", run_count: 2 }],
    },
    {
      id: "vllm",
      label: "vLLM",
      repository: "vllm-project/vllm",
      default_branch: "main",
      note: "No Radeon or Ryzen AI GPU is tested upstream.",
      forks: [],
      badge: { state: "down", reason: "No Radeon or Ryzen AI GPU is tested upstream." },
      kpis: { decided: 0, passed: 0, pass_rate: null, not_running: 0, merged_red: 0 },
      jobs: [],
      platforms: {
        linux: { built: false, built_rate: null, tested: false, tested_rate: null, shipped: null },
        windows: { built: false, built_rate: null, tested: false, tested_rate: null, shipped: null },
      },
      findings: [],
      coverage: { complete: true },
      files: [],
    },
  ],
};

export const upstreamRuns = {
  schema_version: 1,
  project: "llamacpp",
  month: "2026-10",
  runs: [
    {
      job: "gpu-rocm",
      run_id: "1",
      job_id: "11",
      day: "2026-10-27",
      created_at: "2026-10-27T10:00:00Z",
      event: "push",
      ref: "master",
      sha: "a".repeat(40),
      state: "failed",
      failed_step: "Test",
      queue_seconds: 30,
      runner: "box",
      url: "https://github.com/ggml-org/llama.cpp/actions/runs/1/job/11",
      pr: { number: 501, url: "https://github.com/ggml-org/llama.cpp/pull/501", verdict: "failed", author: "dev" },
    },
    {
      job: "gpu-rocm",
      run_id: "2",
      job_id: "21",
      day: "2026-10-27",
      created_at: "2026-10-27T11:00:00Z",
      event: "push",
      ref: "master",
      sha: "b".repeat(40),
      state: "passed",
      failed_step: null,
      queue_seconds: 30,
      runner: "box",
      url: "https://github.com/ggml-org/llama.cpp/actions/runs/2/job/21",
    },
  ],
};

export function upstreamFetch(extra: Record<string, unknown> = {}) {
  return fixtureFetch({
    [indexUrl]: {
      ...index,
      upstream: { schema_version: 1, overview: "upstream/overview.json", project_count: 2, status: "fresh" },
    },
    [new URL("upstream/overview.json", indexUrl).href]: upstreamOverview,
    [new URL("upstream/llamacpp/ci/2026-10.json", indexUrl).href]: upstreamRuns,
    ...extra,
  });
}

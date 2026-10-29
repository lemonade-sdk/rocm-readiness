import type { Build, Session } from "../data";

export const producerCommit = "a".repeat(40);
export const sourceUrl = `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${producerCommit}/qualification/index.json`;

export const session: Session = {
  pointer: {
    schema_version: 1,
    data_commit: "b".repeat(40),
    index_url:
      "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/" +
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/data/index.json",
    sync: {
      status: "success",
      attempted_at: "2026-10-29T00:43:37Z",
      last_successful_at: "2026-10-29T00:43:37Z",
      errors: [],
    },
  },
  index: {
    schema_version: 2,
    generated_at: "2026-10-29T00:43:37Z",
    default_version: "10.1",
    versions: [],
  },
  indexUrl:
    "https://raw.githubusercontent.com/lemonade-sdk/rocm-readiness/" +
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/data/index.json",
  version: "10.1",
  overview: null,
};

export function reportUrl(buildId: string, commit = producerCommit) {
  return `https://raw.githubusercontent.com/lemonade-sdk/llama.cpp/${commit}/qualification/reports/${buildId}.json`;
}

export function buildFixture(overrides: Partial<Build> = {}): Build {
  const buildId = overrides.build_id ?? "run-1-ubuntu-rocm-10.1";
  return {
    build_id: buildId,
    engine: "llamacpp",
    channel: "stable",
    rocm_version: "10.1",
    os: "linux",
    tag: "b12345",
    generated_at: "2026-10-29T00:43:37Z",
    qualified: true,
    version_qualified: true,
    overall: "pass",
    hardware_validated: true,
    report_url: reportUrl(buildId),
    gfx_target: "gfx1151",
    tests: {
      passed: 16,
      failed: 0,
      warned: 0,
      skipped: 1,
      missing: 0,
      total: 17,
    },
    gfx: { requested: 27, present: 27, missing: [] },
    source_id: "stable-qualification",
    source_url: sourceUrl,
    artifact: "llama-b12345-bin-ubuntu-rocm-10.1-x64.tar.gz",
    run_id: "run-1",
    upstream_sha: "c".repeat(40),
    event: "schedule",
    results: { "T0.1": "pass" },
    ...overrides,
  };
}

export function producerReport(
  feedBuild: Build,
  overrides: {
    build?: Record<string, unknown>;
    tiers?: Record<string, unknown>;
  } = {},
) {
  const os = feedBuild.os === "windows" ? "win" : "ubuntu";
  return {
    schema_version: 1,
    kind: "qualification_record",
    generated_at: feedBuild.generated_at,
    build: {
      build_id: `${feedBuild.artifact}@${feedBuild.run_id}`,
      artifact: feedBuild.artifact,
      os,
      rocm_version: feedBuild.rocm_version,
      llamacpp_tag: feedBuild.tag,
      upstream_sha: feedBuild.upstream_sha,
      gfx_target: feedBuild.gfx_target,
      hardware_validated: feedBuild.hardware_validated,
      run_id: feedBuild.run_id,
      run_attempt: "1",
      ...overrides.build,
    },
    overall: "warn",
    promoted: true,
    promotion: { blocked_by: [] },
    counts: { pass: 1, fail: 1, warn: 1, skip: 1, missing: 1, total: 5 },
    gfx: {
      requested: ["gfx1100", "gfx1151"],
      present_in_binary: ["gfx1100", "gfx1151"],
      missing_from_binary: [],
      hardware_validated: ["gfx1151"],
    },
    tiers: {
      tier0: {
        tier_name: "Static artifact verification",
        status: "warn",
        counts: { pass: 1, fail: 1, warn: 1, skip: 1, missing: 1, total: 5 },
        tests: [
          {
            id: "T0.1",
            name: "archive contents",
            status: "warn",
            gating: true,
            duration_ms: 12,
            error: "extra binary",
            details: { compatibility: "ROCm 10.1", audited: true },
          },
          {
            id: "T0.2",
            name: "runtime dependencies",
            status: "fail",
            gating: true,
            duration_ms: 8,
            error: "hipblas missing",
            details: { runtime: "hipblas.dll missing" },
          },
          {
            id: "T0.3",
            name: "GPU offload",
            status: "skip",
            gating: false,
            duration_ms: 0,
            error: "hardware unavailable",
            details: { gpu_offload: "not exercised" },
          },
          {
            id: "T0.4",
            name: "future check",
            status: "missing",
            gating: true,
            duration_ms: null,
            error: null,
            details: {},
          },
        ],
      },
      ...overrides.tiers,
    },
  };
}
